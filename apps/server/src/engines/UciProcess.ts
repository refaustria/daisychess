import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parseUciBestMove, parseUciInfo, type BestMove, type EngineInfo } from '@chesslab/engine-core';

/**
 * UCI options a client request can ever reach a native process with. Everything else
 * (`Debug Log File`, `EvalFile`, `SyzygyPath`, …) would let a caller write files or read
 * arbitrary paths, so {@link UciProcess.setOptions} rejects it.
 */
export const ALLOWED_UCI_OPTIONS = ['Threads', 'Hash', 'MultiPV', 'UCI_Chess960'] as const;
export type AllowedUciOption = (typeof ALLOWED_UCI_OPTIONS)[number];
export type UciOptions = Partial<Record<AllowedUciOption, number | boolean>>;

export interface GoParams {
  depth?: number;
  movetime?: number;
  /** Search until `stop`. Implied when neither `depth` nor `movetime` is given. */
  infinite?: boolean;
}

export interface SearchResult {
  /** null for `bestmove (none)` (mate/stalemate) or an unparsable reply. */
  bestMove: BestMove | null;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the exit was requested through {@link UciProcess.dispose}. */
  expected: boolean;
  /** Last stderr lines (at most 20), for diagnostics. */
  stderr: string[];
  /** Set when the process could not be spawned at all (e.g. ENOENT). */
  error?: Error;
}

export interface UciProcessOptions {
  args?: string[];
  cwd?: string;
  /** Timeout for `uci` → `uciok` and the initial `isready`. Default 10 s. */
  handshakeTimeoutMs?: number;
  /** Default timeout for `isready` → `readyok`. Default 5 s. */
  readyTimeoutMs?: number;
  /** Delay between SIGTERM and SIGKILL on dispose. Default 2 s. */
  killTimeoutMs?: number;
}

export class UciProcessExitedError extends Error {
  constructor(readonly exit: ExitInfo) {
    super(
      `engine process exited (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'null'})` +
        (exit.error ? `: ${exit.error.message}` : ''),
    );
    this.name = 'UciProcessExitedError';
  }
}

export class UciTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`engine did not answer ${what} within ${ms} ms`);
    this.name = 'UciTimeoutError';
  }
}

/** Upper bound for one unterminated stdout line; protects against a runaway process. */
const MAX_LINE_BUFFER = 1024 * 1024;
const STDERR_KEEP = 20;

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

interface PendingSearch {
  promise: Promise<SearchResult>;
  resolve: (r: SearchResult) => void;
  reject: (err: Error) => void;
  onInfo?: (info: EngineInfo) => void;
  stopSent: boolean;
}

type LineListener = (line: string) => void;
type ExitListener = (exit: ExitInfo) => void;

/**
 * One native UCI engine process. Spawned without a shell; stdout is line-buffered; every
 * command is a single line. Only one search can run at a time.
 */
export class UciProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private readonly lineListeners = new Set<LineListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private readonly stderrLines: string[] = [];
  private uciokWaiter: Waiter | null = null;
  private readonly readyWaiters: Waiter[] = [];
  private search: PendingSearch | null = null;
  private exitInfo: ExitInfo | null = null;
  private exitPromise: Promise<ExitInfo> | null = null;
  private disposing = false;
  private readonly optionValues = new Map<AllowedUciOption, string>();
  /** Option names announced by the engine during the handshake. */
  readonly supportedOptions = new Set<string>();
  engineName: string | null = null;

  constructor(
    readonly binary: string,
    private readonly options: UciProcessOptions = {},
  ) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Spawned, not exited, not being disposed. */
  get alive(): boolean {
    return this.child !== null && this.exitInfo === null && !this.disposing;
  }

  get searching(): boolean {
    return this.search !== null;
  }

  get exited(): ExitInfo | null {
    return this.exitInfo;
  }

  /** Spawns the process and performs the `uci`/`isready` handshake. */
  async start(): Promise<void> {
    if (this.child) throw new Error('UciProcess already started');
    const child = spawn(this.binary, this.options.args ?? [], {
      cwd: this.options.cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    let resolveExit!: (e: ExitInfo) => void;
    this.exitPromise = new Promise((r) => (resolveExit = r));

    const finalize = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (this.exitInfo) return;
      const info: ExitInfo = {
        code,
        signal,
        expected: this.disposing,
        stderr: [...this.stderrLines],
      };
      if (error) info.error = error;
      this.exitInfo = info;
      this.failAll(new UciProcessExitedError(info));
      for (const l of [...this.exitListeners]) l(info);
      resolveExit(info);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) continue;
        this.stderrLines.push(line.slice(0, 500));
        if (this.stderrLines.length > STDERR_KEEP) this.stderrLines.shift();
      }
    });
    // EPIPE when writing to a dead process surfaces here; the exit path reports it.
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      // Spawn failure (ENOENT/EACCES): no 'exit' follows in every Node version.
      if (child.pid === undefined) finalize(null, null, err);
    });
    child.on('close', (code, signal) => finalize(code, signal));

    const timeout = this.options.handshakeTimeoutMs ?? 10_000;
    const uciok = new Promise<void>((resolve, reject) => {
      this.uciokWaiter = { resolve, reject };
    });
    try {
      this.send('uci');
      try {
        await withTimeout(uciok, timeout, () => new UciTimeoutError('uci', timeout));
      } finally {
        this.uciokWaiter = null;
      }
      await this.isReady(timeout);
    } catch (err) {
      // Never leave a half-initialised process behind.
      await this.dispose();
      throw err;
    }
  }

  /** Sends one command line. Throws on embedded newlines or when the process is gone. */
  send(line: string): void {
    if (/[\r\n]/.test(line)) throw new Error('UCI command must be a single line');
    if (!this.child || this.exitInfo) throw new UciProcessExitedError(this.exitOrUnknown());
    this.child.stdin.write(line + '\n');
  }

  /** Subscribes to every stdout line. Returns an unsubscribe function. */
  onLine(cb: LineListener): () => void {
    this.lineListeners.add(cb);
    return () => this.lineListeners.delete(cb);
  }

  /** Subscribes to process exit (crash or dispose). Fires at most once. */
  onExit(cb: ExitListener): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  async isReady(timeoutMs = this.options.readyTimeoutMs ?? 5_000): Promise<void> {
    const p = new Promise<void>((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
    try {
      this.send('isready');
    } catch (err) {
      this.readyWaiters.pop();
      throw err;
    }
    await withTimeout(p, timeoutMs, () => new UciTimeoutError('isready', timeoutMs));
  }

  /**
   * Sets options from the allow-list, skipping values that are already in effect, and waits for
   * `readyok` when anything was sent (e.g. Hash reallocation). Throws for any other option name.
   */
  async setOptions(options: UciOptions): Promise<void> {
    const lines: string[] = [];
    for (const [name, value] of Object.entries(options)) {
      if (!(ALLOWED_UCI_OPTIONS as readonly string[]).includes(name)) {
        throw new Error(`UCI option "${name}" is not allowed`);
      }
      if (value === undefined) continue;
      if (typeof value === 'number' && !Number.isInteger(value)) {
        throw new Error(`UCI option "${name}" must be an integer`);
      }
      const v = String(value);
      const key = name as AllowedUciOption;
      if (this.optionValues.get(key) === v) continue;
      lines.push(`setoption name ${key} value ${v}`);
      this.optionValues.set(key, v);
    }
    if (lines.length === 0) return;
    if (this.searching) throw new Error('cannot set options while searching');
    for (const l of lines) this.send(l);
    await this.isReady();
  }

  /** `position fen <fen>` (the FEN must already be validated; newlines are rejected by send). */
  position(fen: string): void {
    this.send(`position fen ${fen}`);
  }

  /**
   * Starts a search. Resolves with the `bestmove` (after `stop` too), rejects when the process
   * exits first. `onInfo` receives every parsable `info … score … pv` line of this search.
   */
  go(params: GoParams, onInfo?: (info: EngineInfo) => void): Promise<SearchResult> {
    if (this.search) throw new Error('a search is already running');
    const parts = ['go'];
    if (params.depth !== undefined) parts.push('depth', String(Math.trunc(params.depth)));
    if (params.movetime !== undefined) parts.push('movetime', String(Math.trunc(params.movetime)));
    if (parts.length === 1 || params.infinite) parts.push('infinite');
    let resolve!: (r: SearchResult) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<SearchResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const search: PendingSearch = { promise, resolve, reject, stopSent: false };
    if (onInfo) search.onInfo = onInfo;
    this.send(parts.join(' '));
    this.search = search;
    return promise;
  }

  /** Sends `stop` (once) when a search runs; resolves with its result, or null when idle. */
  stop(): Promise<SearchResult | null> {
    const s = this.search;
    if (!s) return Promise.resolve(null);
    if (!s.stopSent && this.alive) {
      s.stopSent = true;
      this.send('stop');
    }
    return s.promise;
  }

  /** `ucinewgame` + `isready`. */
  async newGame(timeoutMs?: number): Promise<void> {
    this.send('ucinewgame');
    await this.isReady(timeoutMs);
  }

  /** Sends `quit`, then SIGTERM, then SIGKILL after `killTimeoutMs`. Resolves once exited. */
  async dispose(): Promise<ExitInfo | null> {
    if (!this.child || !this.exitPromise) return null;
    if (this.exitInfo) return this.exitInfo;
    const child = this.child;
    if (!this.disposing) {
      this.disposing = true;
      try {
        child.stdin.write('quit\n');
        child.stdin.end();
      } catch {
        // already closed
      }
      child.kill('SIGTERM');
      const t = setTimeout(() => {
        if (!this.exitInfo) child.kill('SIGKILL');
      }, this.options.killTimeoutMs ?? 2_000);
      t.unref();
      void this.exitPromise.then(() => clearTimeout(t));
    }
    return this.exitPromise;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      this.handleLine(line);
    }
    if (this.buffer.length > MAX_LINE_BUFFER) this.buffer = '';
  }

  private handleLine(line: string): void {
    if (line.startsWith('info ')) {
      const s = this.search;
      if (s?.onInfo) {
        const info = parseUciInfo(line);
        if (info) s.onInfo(info);
      }
    } else if (line.startsWith('bestmove')) {
      const s = this.search;
      if (s) {
        this.search = null;
        s.resolve({ bestMove: parseUciBestMove(line) });
      }
    } else if (line === 'readyok') {
      this.readyWaiters.shift()?.resolve();
    } else if (line === 'uciok') {
      this.uciokWaiter?.resolve();
    } else if (line.startsWith('option name ')) {
      const m = /^option name (.+?) type /.exec(line);
      if (m?.[1]) this.supportedOptions.add(m[1]);
    } else if (line.startsWith('id name ')) {
      this.engineName = line.slice('id name '.length).trim();
    }
    for (const l of [...this.lineListeners]) l(line);
  }

  private failAll(err: Error): void {
    this.uciokWaiter?.reject(err);
    this.uciokWaiter = null;
    for (const w of this.readyWaiters.splice(0)) w.reject(err);
    const s = this.search;
    this.search = null;
    s?.reject(err);
  }

  private exitOrUnknown(): ExitInfo {
    return this.exitInfo ?? { code: null, signal: null, expected: false, stderr: [] };
  }
}

/** Races `p` against a timer; the timer never keeps the event loop alive. */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(onTimeout()), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
