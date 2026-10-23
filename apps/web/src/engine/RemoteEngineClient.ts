import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  checkAnalyzeLimits,
  infoToWhitePov,
  parseServerMessage,
  sideToMove,
  type AnalyzeMessage,
  type AnalyzeOptions,
  type BestMove,
  type ClientMessage,
  type EngineDescriptor,
  type EngineInfo,
  type ErrorMessage,
  type Limits,
  type ProtocolErrorCode,
  type ServerMessage,
  type WelcomeMessage,
} from '@chesslab/engine-core';
import type { AnalysisEngine, EngineCapabilities } from './AnalysisController';
import type { AnalysisHandle } from './UciSession';

/** The subset of the browser `WebSocket` the client uses (injectable for tests). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
}

/** `WebSocket.OPEN` (not referenced through the global so the module also loads without one). */
const WS_OPEN = 1;

export type RemoteEngineStatus = 'idle' | 'connecting' | 'ready' | 'closed' | 'error';

export interface RemoteEngineClientOptions {
  /** Defaults to `ws(s)://<current host>/ws` (wss on https pages). */
  url?: string;
  /** Engine id from `welcome.engines`; defaults to the first enabled engine. */
  engineId?: string;
  /** Socket factory; defaults to `new WebSocket(url)`. */
  createSocket?: (url: string) => WebSocketLike;
  /** Max time from opening the socket to `welcome`. Default 10 s. */
  handshakeTimeoutMs?: number;
  /** Max time a stopped/replaced search may take to deliver its terminal message. Default 10 s. */
  responseTimeoutMs?: number;
  /** Sent in `hello.client`. */
  clientInfo?: { name: string; version?: string };
  /**
   * Server access token, sent in `hello.token` (ADR-010). Empty/undefined sends none; a server
   * with `ACCESS_TOKEN` then answers `unauthorized`.
   */
  token?: string;
}

export interface RemoteEngineCapabilities extends EngineCapabilities {
  /** Native engines on the server always support threads. */
  threads: true;
}

/** Error carrying the protocol error code (when the server sent one). */
export class RemoteEngineError extends Error {
  constructor(
    message: string,
    readonly code?: ProtocolErrorCode | 'timeout' | 'closed' | 'invalid_request',
  ) {
    super(message);
    this.name = 'RemoteEngineError';
  }
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

/** One remote search (`searchId`): a single-consumer stream of White-POV infos plus `bestMove`. */
class RemoteSearch implements AnalysisHandle {
  done = false;
  /** `stop` sent or replaced by a newer `analyze`; its terminal message is awaited. */
  stopping = false;
  stopTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly buffer: EngineInfo[] = [];
  private waiter: Deferred<IteratorResult<EngineInfo>> | null = null;
  private error: Error | null = null;
  private readonly result = new Deferred<BestMove | null>();

  constructor(
    readonly searchId: number,
    readonly toMove: 'w' | 'b',
    private readonly onReturn: (s: RemoteSearch) => void,
  ) {}

  get bestMove(): Promise<BestMove | null> {
    return this.result.promise;
  }

  push(info: EngineInfo): void {
    if (this.done) return;
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
    if (this.done) return;
    this.done = true;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.error = error ?? null;
    this.result.resolve(best);
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
    if (this.done) {
      const err = this.error;
      this.error = null;
      return err ? Promise.reject(err) : Promise.resolve({ value: undefined, done: true });
    }
    if (this.waiter) return this.waiter.promise.then(() => this.next());
    this.waiter = new Deferred();
    return this.waiter.promise;
  }

  [Symbol.asyncIterator](): AsyncIterator<EngineInfo> {
    return {
      next: () => this.next(),
      return: () => {
        // Consumer stopped iterating (break / throw in for-await): stop the remote search.
        this.onReturn(this);
        this.buffer.length = 0;
        this.error = null;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

function failedHandle(err: Error): AnalysisHandle {
  return {
    bestMove: Promise.resolve(null),
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }),
  };
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** Random `[A-Za-z0-9_-]{16}` (64 symbols, so `byte & 63` is unbiased). */
export function randomSessionId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += ID_ALPHABET[b & 63];
  return id;
}

function defaultUrl(): string {
  const loc = globalThis.location;
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

/** Client-settable options (ADR-006: the only UCI options carried on `analyze`). */
const OPTION_KEYS = { threads: 'threads', hash: 'hash', multipv: 'multipv' } as const;
type OptionKey = (typeof OPTION_KEYS)[keyof typeof OPTION_KEYS];

const clamp = (v: number | undefined, max: number): number | undefined =>
  v === undefined ? undefined : Math.min(v, max);

/**
 * Native engine on the ChessLab server over the WebSocket protocol (ADR-006), implementing the
 * same {@link AnalysisEngine} shape as {@link WasmEngineClient}.
 *
 * - One connection and one server session (random `sessionId`) per client instance; every
 *   `analyze` gets the next `searchId`. Messages are attributed by `searchId`, so a replaced
 *   search's late `info`/`bestmove` never reaches the new handle.
 * - A new `analyze` while one runs is sent immediately; the server stops the old search and
 *   delivers its `bestmove reason: stopped` first, which completes the old handle.
 * - Scores are converted to White's point of view here (`infoToWhitePov`); the server relays raw
 *   side-to-move UCI scores.
 * - `multipv`, `depth`, `threads` and `hash` are **clamped** to `welcome.limits` (a UI asking for
 *   depth 40 on a server allowing 30 gets depth 30 instead of an error); a `movetime` beyond the
 *   limit fails the handle with `limit_exceeded` without a round trip.
 * - No automatic reconnect: when the socket closes all handles fail and status becomes `closed`;
 *   calling {@link load} again opens a new connection (server sessions never survive one).
 */
export class RemoteEngineClient implements AnalysisEngine {
  readonly url: string;
  readonly sessionId = randomSessionId();
  private readonly options: RemoteEngineClientOptions;
  private readonly handshakeTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private socket: WebSocketLike | null = null;
  private loading: Promise<void> | null = null;
  private welcome: WelcomeMessage | null = null;
  private engine: EngineDescriptor | null = null;
  private disposed = false;
  /** Rejects the pending handshake (dispose during load). */
  private abortHandshake: ((err: Error) => void) | null = null;
  private nextSearchId = 1;
  private readonly searches = new Map<number, RemoteSearch>();
  /** Most recently sent search (the one the server is or will be running). */
  private latest: RemoteSearch | null = null;
  private readonly requested: Partial<Record<OptionKey, number>> = {};
  private stopWaiters: (() => void)[] = [];
  private currentStatus: RemoteEngineStatus = 'idle';
  private statusError: string | undefined;
  private readonly listeners = new Set<(status: RemoteEngineStatus, error?: string) => void>();

  constructor(options: RemoteEngineClientOptions = {}) {
    this.options = options;
    this.url = options.url ?? defaultUrl();
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 10_000;
  }

  // --- metadata --------------------------------------------------------------------------------

  get status(): RemoteEngineStatus {
    return this.currentStatus;
  }

  /** Reason for the last `error`/`closed` status (if any). */
  get lastError(): string | undefined {
    return this.statusError;
  }

  /** Subscribes to status changes; returns the unsubscribe function. */
  onStatus(cb: (status: RemoteEngineStatus, error?: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Display name of the selected engine (after {@link load}). */
  get engineName(): string | undefined {
    return this.engine?.name;
  }

  /** Engine id used for `analyze` (after {@link load}). */
  get engineId(): string | undefined {
    return this.engine?.id;
  }

  get limits(): Limits | undefined {
    return this.welcome?.limits;
  }

  get engines(): readonly EngineDescriptor[] {
    return this.welcome?.engines ?? [];
  }

  get serverVersion(): string | undefined {
    return this.welcome?.serverVersion;
  }

  capabilities(): RemoteEngineCapabilities {
    const requested = this.requested.threads ?? this.engine?.defaults.threads ?? 1;
    const max = this.welcome?.limits.maxThreads ?? requested;
    return {
      threads: true,
      build: `${this.engine?.name ?? 'remote'}@${this.welcome?.serverVersion ?? '?'}`,
      threadCount: Math.min(requested, max),
    };
  }

  // --- lifecycle -------------------------------------------------------------------------------

  /** Connects and completes the `hello`/`welcome` handshake. Idempotent; retryable after failure or close. */
  load(): Promise<void> {
    if (this.disposed)
      return Promise.reject(new RemoteEngineError('Engine has been disposed', 'closed'));
    this.loading ??= this.connect().catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.disposed) throw error;
      this.teardownSocket();
      this.loading = null;
      this.setStatus('error', error.message);
      throw error;
    });
    return this.loading;
  }

  private connect(): Promise<void> {
    this.setStatus('connecting');
    this.welcome = null;
    this.engine = null;
    const handshake = new Deferred<void>();
    let socket: WebSocketLike;
    try {
      socket = (this.options.createSocket ?? ((url: string): WebSocketLike => new WebSocket(url)))(
        this.url,
      );
    } catch (err) {
      return Promise.reject(
        new RemoteEngineError(`Cannot connect to ${this.url}: ${(err as Error).message}`, 'closed'),
      );
    }
    this.socket = socket;
    this.abortHandshake = (err) => handshake.reject(err);
    let handshaken = false;
    let serverError: ErrorMessage | null = null;
    const timer = setTimeout(
      () =>
        handshake.reject(
          new RemoteEngineError(
            `Engine server did not complete the handshake within ${this.handshakeTimeoutMs} ms`,
            'timeout',
          ),
        ),
      this.handshakeTimeoutMs,
    );

    socket.onopen = () => {
      const hello: ClientMessage = {
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        client: this.options.clientInfo ?? { name: 'chesslab-web' },
        ...(this.options.token ? { token: this.options.token } : {}),
      };
      this.send(hello);
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      const parsed = parseServerMessage(ev.data);
      if (!parsed.ok) {
        console.warn(`[remote engine] ignoring invalid server message: ${parsed.error}`);
        return;
      }
      const msg = parsed.message;
      if (handshaken) {
        this.handleMessage(msg);
        return;
      }
      if (msg.type === 'welcome') {
        try {
          this.engine = this.selectEngine(msg);
        } catch (err) {
          handshake.reject(err as Error);
          return;
        }
        handshaken = true;
        this.welcome = msg;
        handshake.resolve();
      } else if (msg.type === 'error') {
        serverError = msg;
        handshake.reject(new RemoteEngineError(`Engine server: ${msg.message}`, msg.code));
      }
    };
    socket.onerror = () => {
      // Browsers fire `close` right after `error`; the reason is reported there.
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      if (!handshaken) {
        const why = serverError
          ? `Engine server: ${serverError.message}`
          : `Cannot connect to engine server at ${this.url} (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`;
        handshake.reject(new RemoteEngineError(why, serverError?.code ?? 'closed'));
        return;
      }
      this.onConnectionLost(
        new RemoteEngineError(
          `Connection to engine server closed (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`,
          'closed',
        ),
      );
    };

    return handshake.promise.then(
      () => {
        clearTimeout(timer);
        this.abortHandshake = null;
        this.setStatus('ready');
      },
      (err: Error) => {
        clearTimeout(timer);
        this.abortHandshake = null;
        throw err;
      },
    );
  }

  private selectEngine(welcome: WelcomeMessage): EngineDescriptor {
    const wanted = this.options.engineId;
    if (wanted !== undefined) {
      const e = welcome.engines.find((x) => x.id === wanted);
      if (!e)
        throw new RemoteEngineError(`Engine server has no engine "${wanted}"`, 'unknown_engine');
      if (!e.enabled)
        throw new RemoteEngineError(
          `Engine "${wanted}" is disabled on the server`,
          'unknown_engine',
        );
      return e;
    }
    const e = welcome.engines.find((x) => x.enabled);
    if (!e) throw new RemoteEngineError('Engine server has no enabled engine', 'unknown_engine');
    return e;
  }

  /**
   * Remembers `Threads`, `Hash` and `MultiPV` (case-insensitive) for the next {@link analyze}
   * (there is no setOptions message; ADR-006). Other options are rejected. Does not restart a
   * running search.
   */
  setOptions(options: Record<string, string | number | boolean>): Promise<void> {
    const updates: [OptionKey, number][] = [];
    for (const [name, raw] of Object.entries(options)) {
      const lower = name.toLowerCase();
      const key = Object.hasOwn(OPTION_KEYS, lower)
        ? OPTION_KEYS[lower as keyof typeof OPTION_KEYS]
        : undefined;
      if (!key) {
        return Promise.reject(
          new RemoteEngineError(
            `Option "${name}" is not supported by the remote engine (supported: Threads, Hash, MultiPV)`,
            'invalid_request',
          ),
        );
      }
      const value = typeof raw === 'boolean' ? NaN : Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        return Promise.reject(
          new RemoteEngineError(
            `Option ${name} must be a positive integer, got ${String(raw)}`,
            'invalid_request',
          ),
        );
      }
      updates.push([key, value]);
    }
    for (const [key, value] of updates) this.requested[key] = value;
    return Promise.resolve();
  }

  /**
   * Analyzes `fen` on the server; yields `info` updates (White-POV scores) and completes on
   * `bestmove`. A running analysis is replaced (its iterator completes once the server confirms).
   */
  analyze(fen: string, opts: AnalyzeOptions = {}): AnalysisHandle {
    const welcome = this.welcome;
    const engine = this.engine;
    if (this.disposed)
      return failedHandle(new RemoteEngineError('Engine has been disposed', 'closed'));
    if (this.currentStatus !== 'ready' || !welcome || !engine) {
      return failedHandle(
        new RemoteEngineError(
          this.currentStatus === 'closed'
            ? `Not connected to the engine server${this.statusError ? ` (${this.statusError})` : ''}`
            : 'Engine not loaded; call load() first',
          'closed',
        ),
      );
    }
    const { limits } = welcome;
    const searchId = this.nextSearchId;
    const multipv = clamp(opts.multipv ?? this.requested.multipv, limits.maxMultipv);
    const depth = clamp(opts.depth, limits.maxDepth);
    const threads = clamp(this.requested.threads, limits.maxThreads);
    const hash = clamp(this.requested.hash, limits.maxHash);
    const msg: AnalyzeMessage = {
      type: 'analyze',
      sessionId: this.sessionId,
      searchId,
      engine: engine.id,
      fen: fen.trim(),
      ...(multipv !== undefined && { multipv }),
      ...(depth !== undefined && { depth }),
      ...(opts.movetime !== undefined && { movetime: opts.movetime }),
      ...(threads !== undefined && { threads }),
      ...(hash !== undefined && { hash }),
    };
    const valid = ClientMessageSchema.safeParse(msg);
    if (!valid.success) {
      const detail = valid.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return failedHandle(
        new RemoteEngineError(`Invalid analysis request: ${detail}`, 'invalid_request'),
      );
    }
    const violation = checkAnalyzeLimits(msg, limits);
    if (violation) return failedHandle(new RemoteEngineError(violation, 'limit_exceeded'));

    this.nextSearchId++;
    const search = new RemoteSearch(searchId, sideToMove(fen), (s) => this.cancel(s));
    const previous = this.latest;
    this.searches.set(searchId, search);
    this.latest = search;
    // The server stops the previous search itself; we only guard its terminal message.
    if (previous && !previous.done) this.markStopping(previous);
    this.send(msg);
    return search;
  }

  /** Stops the current analysis; resolves once every running search delivered its terminal message. */
  stop(): Promise<void> {
    const latest = this.latest;
    if (latest && !latest.done) this.cancel(latest);
    return this.whenIdle();
  }

  /** Releases the server session and closes the socket; running iterators complete normally. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abortHandshake?.(new RemoteEngineError('Engine has been disposed', 'closed'));
    this.abortHandshake = null;
    const socket = this.socket;
    if (socket && socket.readyState === WS_OPEN && this.nextSearchId > 1) {
      this.send({ type: 'release', sessionId: this.sessionId });
    }
    this.finishAll(null);
    this.teardownSocket(1000, 'client disposed');
    this.loading = null;
    this.setStatus('closed');
  }

  // --- internals -------------------------------------------------------------------------------

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'info': {
        if (msg.sessionId !== this.sessionId) return;
        const s = this.searches.get(msg.searchId);
        s?.push(infoToWhitePov(msg.info, s.toMove));
        return;
      }
      case 'bestmove': {
        if (msg.sessionId !== this.sessionId) return;
        this.settle(msg.searchId, msg.bestMove);
        return;
      }
      case 'error':
        this.handleError(msg);
        return;
      case 'welcome':
      case 'pong':
        return;
    }
  }

  private handleError(msg: ErrorMessage): void {
    const err = new RemoteEngineError(`Engine server: ${msg.message}`, msg.code);
    if (msg.sessionId !== undefined) {
      if (msg.sessionId !== this.sessionId) return;
      if (msg.searchId !== undefined) {
        this.settle(msg.searchId, null, err);
      } else if (msg.code !== 'session_not_found') {
        // Session-level (e.g. engine_crashed while idle): every search of the session is gone.
        // `session_not_found` only answers a `stop` that raced with a rejected `analyze`; benign.
        this.finishAll(null, err);
      }
      return;
    }
    // Connection-level: the server is about to close (rate_limited) or we spoke off-contract.
    this.onConnectionLost(err);
    this.teardownSocket(1000, 'connection error');
  }

  private settle(searchId: number, best: BestMove | null, error?: Error): void {
    const s = this.searches.get(searchId);
    if (!s) return;
    this.searches.delete(searchId);
    s.finish(best, error);
    if (this.latest === s) this.latest = null;
    this.notifyIdle();
  }

  /** Iterator `return()` or {@link stop}: sends `stop` if `s` is what the server runs now. */
  private cancel(s: RemoteSearch): void {
    if (s.done || s.stopping) return;
    if (this.latest !== s) return; // superseded: the server already stops it
    this.markStopping(s);
    this.send({ type: 'stop', sessionId: this.sessionId });
  }

  private markStopping(s: RemoteSearch): void {
    if (s.stopping) return;
    s.stopping = true;
    s.stopTimer = setTimeout(() => {
      if (s.done) return;
      // A server that does not end a stopped search is broken; give up on the connection.
      const err = new RemoteEngineError(
        `Engine server did not end search ${s.searchId} within ${this.responseTimeoutMs} ms`,
        'timeout',
      );
      this.onConnectionLost(err);
      this.teardownSocket(1000, 'response timeout');
    }, this.responseTimeoutMs);
  }

  private whenIdle(): Promise<void> {
    if (this.searches.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.stopWaiters.push(resolve));
  }

  private notifyIdle(): void {
    if (this.searches.size > 0) return;
    const waiters = this.stopWaiters;
    this.stopWaiters = [];
    for (const w of waiters) w();
  }

  private finishAll(best: null, error?: Error): void {
    const all = [...this.searches.values()];
    this.searches.clear();
    this.latest = null;
    for (const s of all) s.finish(best, error);
    this.notifyIdle();
  }

  private onConnectionLost(err: RemoteEngineError): void {
    if (this.currentStatus === 'closed') return;
    this.finishAll(null, err);
    this.loading = null;
    this.setStatus('closed', err.message);
  }

  private send(msg: ClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) {
      // Only reachable in a close race; the close handler fails the handles.
      return;
    }
    if (import.meta.env.DEV) {
      const check = ClientMessageSchema.safeParse(msg);
      if (!check.success) throw new Error(`Off-contract client message: ${check.error.message}`);
    }
    socket.send(JSON.stringify(msg));
  }

  private teardownSocket(code?: number, reason?: string): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(code, reason);
    } catch {
      // already closed
    }
  }

  private setStatus(status: RemoteEngineStatus, error?: string): void {
    if (status === this.currentStatus && error === this.statusError) return;
    this.currentStatus = status;
    this.statusError = status === 'error' || status === 'closed' ? error : undefined;
    for (const cb of [...this.listeners]) cb(status, this.statusError);
  }
}
