import {
  infoToWhitePov,
  parseUciBestMove,
  parseUciInfo,
  sideToMove,
  type AnalyzeOptions,
  type BestMove,
  type EngineInfo,
} from '@daisychess/engine-core';

/** Line-oriented UCI channel. Implemented by a Web Worker in production and by fakes in tests. */
export interface UciTransport {
  send(line: string): void;
  /** Register the (single) receiver for engine output. A message may contain several lines. */
  onLine(cb: (line: string) => void): void;
}

/** Result of {@link UciSession.analyze}: a single-consumer stream of `info` updates. */
export interface AnalysisHandle extends AsyncIterable<EngineInfo> {
  /** Resolves with the engine's `bestmove` (null for `(none)`, cancellation, dispose or error). Never rejects. */
  readonly bestMove: Promise<BestMove | null>;
}

export interface UciSessionOptions {
  /** Max time for `uci`→`uciok` (includes WASM download/compile) and the first `readyok`. */
  handshakeTimeoutMs?: number;
  /** Max time for `isready`→`readyok` and `stop`→`bestmove`. Exceeding it fails the session. */
  responseTimeoutMs?: number;
  /**
   * Called once with a fatal error ({@link UciSession.fail}: worker error, abort, timeout) before it
   * reaches pending operations and iterators; may return a replacement (e.g. a classified error).
   */
  onFatal?: (error: Error) => Error;
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (err: Error) => void;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

type SearchState = 'pending' | 'running' | 'stopping' | 'done';

/** One `go` command and the async iterator that streams its output. */
class Search implements AnalysisHandle {
  state: SearchState = 'pending';
  readonly toMove: 'w' | 'b';
  private readonly buffer: EngineInfo[] = [];
  private waiter: Deferred<IteratorResult<EngineInfo>> | null = null;
  private error: Error | null = null;
  private readonly done = new Deferred<BestMove | null>();

  constructor(
    readonly fen: string,
    readonly opts: AnalyzeOptions,
    private readonly onReturn: (s: Search) => void,
  ) {
    this.toMove = sideToMove(fen);
  }

  get bestMove(): Promise<BestMove | null> {
    return this.done.promise;
  }

  push(info: EngineInfo): void {
    if (this.state === 'done') return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve({ value: info, done: false });
    } else {
      this.buffer.push(info);
    }
  }

  /** Ends the stream. Buffered infos are still delivered; then `error` (if any) is thrown once. */
  finish(best: BestMove | null, error?: Error): void {
    if (this.state === 'done') return;
    this.state = 'done';
    this.error = error ?? null;
    this.done.resolve(best);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      if (this.error) {
        w.reject(this.error);
        this.error = null;
      } else {
        w.resolve({ value: undefined, done: true });
      }
    }
  }

  private next(): Promise<IteratorResult<EngineInfo>> {
    const info = this.buffer.shift();
    if (info) return Promise.resolve({ value: info, done: false });
    if (this.state === 'done') {
      const err = this.error;
      this.error = null;
      return err ? Promise.reject(err) : Promise.resolve({ value: undefined, done: true });
    }
    // Single consumer: a second concurrent next() would replace the first waiter, so chain instead.
    if (this.waiter) return this.waiter.promise.then(() => this.next());
    this.waiter = new Deferred();
    return this.waiter.promise;
  }

  [Symbol.asyncIterator](): AsyncIterator<EngineInfo> {
    return {
      next: () => this.next(),
      return: () => {
        // Consumer stopped iterating (break / throw in for-await): stop the engine search.
        this.onReturn(this);
        this.buffer.length = 0;
        this.error = null;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

const NEWLINE = /[\r\n]/;

function goCommand(opts: AnalyzeOptions): string {
  const parts = ['go'];
  const positiveInt = (name: string, v: number): number => {
    if (!Number.isInteger(v) || v <= 0)
      throw new Error(`${name} must be a positive integer, got ${v}`);
    return v;
  };
  if (opts.depth !== undefined) parts.push('depth', String(positiveInt('depth', opts.depth)));
  if (opts.movetime !== undefined)
    parts.push('movetime', String(positiveInt('movetime', opts.movetime)));
  if (parts.length === 1) parts.push('infinite');
  return parts.join(' ');
}

/**
 * Pure UCI state machine on top of a {@link UciTransport} (no Worker/DOM dependency).
 *
 * - Control commands (handshake, options, starting a search) run strictly one after another.
 * - At most one search runs in the engine. Starting a new one sends `stop` to the previous
 *   search, waits for its `bestmove` (so no stale `info` lines leak into the new stream) and
 *   only then sends `position`/`go`. The previous iterator completes normally.
 * - Scores are converted to White's point of view (UCI reports them for the side to move).
 * - A fatal error ({@link fail}) or {@link close} ends every pending operation and iterator.
 */
export class UciSession {
  /** `id name …` reported by the engine during the handshake. */
  engineName: string | undefined;
  /** Option names announced by the engine (`option name X type …`). */
  readonly optionNames = new Set<string>();

  private chain: Promise<unknown> = Promise.resolve();
  private uciok: Deferred<void> | null = null;
  private readonly readyWaiters: Deferred<void>[] = [];
  /** Most recently requested search (may still be pending). */
  private latest: Search | null = null;
  /** Search the engine is executing (`go` sent, `bestmove` not yet received). */
  private running: Search | null = null;
  private multipv = 1;
  private terminal: Error | null = null;
  private readonly aborted = new Deferred<never>();
  private readonly handshakeTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly onFatal: ((error: Error) => Error) | undefined;

  constructor(
    private readonly transport: UciTransport,
    opts: UciSessionOptions = {},
  ) {
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 30_000;
    this.responseTimeoutMs = opts.responseTimeoutMs ?? 10_000;
    this.onFatal = opts.onFatal;
    this.aborted.promise.catch(() => undefined);
    transport.onLine((chunk) => {
      for (const line of chunk.split(/\r?\n/)) this.handleLine(line.trim());
    });
  }

  /** True after {@link fail} or {@link close}. */
  get isTerminated(): boolean {
    return this.terminal !== null;
  }

  /** `uci` → `uciok`, then `isready` → `readyok`. */
  handshake(): Promise<void> {
    return this.enqueue(async () => {
      const ok = new Deferred<void>();
      this.uciok = ok;
      this.transport.send('uci');
      await this.guard(ok.promise, this.handshakeTimeoutMs, 'uciok');
      await this.syncReady(this.handshakeTimeoutMs);
    });
  }

  /**
   * Sends `setoption name K value V` for every entry, then waits for `readyok`.
   * UCI forbids changing options during a search, so a running analysis is stopped first
   * (its iterator completes).
   */
  setOptions(options: Record<string, string | number | boolean>): Promise<void> {
    const entries = Object.entries(options).map(([k, v]) => [k, String(v)] as const);
    for (const [k, v] of entries) {
      if (NEWLINE.test(k) || NEWLINE.test(v) || k.trim() === '') {
        return Promise.reject(
          new Error(`Invalid UCI option ${JSON.stringify(k)}=${JSON.stringify(v)}`),
        );
      }
    }
    return this.enqueue(async () => {
      // Only the search the engine is executing now; searches requested after this call are
      // still pending in the queue and must run afterwards with the new options.
      if (this.running) this.cancel(this.running);
      await this.awaitIdle();
      for (const [k, v] of entries) {
        this.transport.send(`setoption name ${k} value ${v}`);
        if (k.toLowerCase() === 'multipv') this.multipv = Number(v);
      }
      await this.syncReady(this.responseTimeoutMs);
    });
  }

  /**
   * Starts a search on `fen` and streams its `info` lines (only those with `score` and `pv`),
   * scores converted to White's perspective. Completes on `bestmove`.
   * Without `depth`/`movetime` the search is `go infinite` and runs until {@link stop}.
   */
  analyze(fen: string, opts: AnalyzeOptions = {}): AnalysisHandle {
    const search = new Search(fen, opts, (s) => this.cancel(s));
    let go: string;
    try {
      if (NEWLINE.test(fen) || fen.trim() === '')
        throw new Error(`Invalid FEN ${JSON.stringify(fen)}`);
      if (opts.multipv !== undefined && (!Number.isInteger(opts.multipv) || opts.multipv < 1)) {
        throw new Error(`multipv must be a positive integer, got ${opts.multipv}`);
      }
      go = goCommand(opts);
    } catch (err) {
      search.finish(null, err as Error);
      return search;
    }
    if (this.terminal) {
      search.finish(null, this.terminal);
      return search;
    }
    const previous = this.latest;
    this.latest = search;
    if (previous) this.cancel(previous);

    this.enqueue(async () => {
      if (search.state !== 'pending') return;
      await this.awaitIdle();
      if (search.state !== 'pending') return;
      if (opts.multipv !== undefined && opts.multipv !== this.multipv) {
        this.transport.send(`setoption name MultiPV value ${opts.multipv}`);
        this.multipv = opts.multipv;
      }
      this.transport.send(`position fen ${fen.trim()}`);
      this.transport.send(go);
      search.state = 'running';
      this.running = search;
    }).catch((err: unknown) =>
      search.finish(null, err instanceof Error ? err : new Error(String(err))),
    );
    return search;
  }

  /** Stops the current analysis; resolves once its `bestmove` arrived (iterator completed). */
  async stop(): Promise<void> {
    if (this.terminal) return;
    if (this.latest) this.cancel(this.latest);
    if (this.running) this.cancel(this.running);
    await this.awaitIdle();
  }

  /** Fatal error (worker crashed, engine aborted, timeout): rejects everything pending. */
  fail(cause: Error): void {
    if (this.terminal) return;
    let error = cause;
    try {
      error = this.onFatal?.(cause) ?? cause;
    } catch {
      /* keep the original error */
    }
    this.terminal = error;
    this.aborted.reject(error);
    this.running?.finish(null, error);
    this.latest?.finish(null, error);
    this.running = null;
  }

  /** Disposes the session: running/pending iterators complete normally, further calls reject. */
  close(): void {
    if (this.terminal) return;
    this.terminal = new Error('Engine has been disposed');
    this.aborted.reject(this.terminal);
    this.running?.finish(null);
    this.latest?.finish(null);
    this.running = null;
  }

  private handleLine(line: string): void {
    if (line === '' || this.terminal) return;
    if (line.startsWith('info ')) {
      const s = this.running;
      if (!s) return;
      const info = parseUciInfo(line);
      if (info) s.push(infoToWhitePov(info, s.toMove));
    } else if (line.startsWith('bestmove')) {
      const s = this.running;
      this.running = null;
      s?.finish(parseUciBestMove(line));
    } else if (line === 'readyok') {
      this.readyWaiters.shift()?.resolve();
    } else if (line === 'uciok') {
      this.uciok?.resolve();
      this.uciok = null;
    } else if (line.startsWith('id name ')) {
      this.engineName = line.slice('id name '.length);
    } else if (line.startsWith('option name ')) {
      const m = /^option name (.+?) type /.exec(line);
      if (m?.[1]) this.optionNames.add(m[1]);
    } else if (line.startsWith('Aborted(')) {
      // Emscripten runtime abort: the engine is dead.
      this.fail(new Error(`Stockfish aborted: ${line}`));
    }
  }

  private cancel(s: Search): void {
    if (s.state === 'pending') {
      s.finish(null);
    } else if (s.state === 'running') {
      s.state = 'stopping';
      this.transport.send('stop');
    }
  }

  /** Waits until no search runs in the engine (the caller has already requested a stop). */
  private async awaitIdle(): Promise<void> {
    const s = this.running;
    if (s) await this.waitBestMove(s);
  }

  private async waitBestMove(s: Search): Promise<void> {
    await this.guard(s.bestMove, this.responseTimeoutMs, 'bestmove');
  }

  private async syncReady(timeoutMs: number): Promise<void> {
    const d = new Deferred<void>();
    this.readyWaiters.push(d);
    this.transport.send('isready');
    await this.guard(d.promise, timeoutMs, 'readyok');
  }

  /** Races `p` against session termination and a timeout; a timeout is fatal for the session. */
  private guard<T>(p: Promise<T>, timeoutMs: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Engine did not answer with '${what}' within ${timeoutMs} ms`);
        this.fail(err);
        reject(err);
      }, timeoutMs);
    });
    return Promise.race([p, this.aborted.promise, timeout]).finally(() => clearTimeout(timer));
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => {
      if (this.terminal) throw this.terminal;
      return op();
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
