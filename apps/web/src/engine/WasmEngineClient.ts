import type { AnalyzeOptions, Engine } from '@chesslab/engine-core';
import { UciSession, type AnalysisHandle, type UciTransport } from './UciSession';

/** Browser builds shipped from the `stockfish` npm package (see vite-plugin-stockfish.ts). */
export type WasmBuild = 'lite' | 'lite-single';

/** The subset of `Worker` the client uses (injectable for tests). */
export interface EngineWorker {
  postMessage(message: string): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
}

export interface WasmEngineClientOptions {
  /** Defaults to `globalThis.crossOriginIsolated`. */
  crossOriginIsolated?: boolean;
  /** Defaults to `navigator.hardwareConcurrency`. */
  hardwareConcurrency?: number;
  /** Force a build instead of auto-selecting (e.g. `lite-single` on an isolated page). */
  build?: WasmBuild;
  /** URL of the directory holding the engine files (trailing slash). Defaults to the bundled one. */
  engineBaseUrl?: string;
  /** Worker factory; defaults to a classic `new Worker(url)` (the engine script is not an ES module). */
  createWorker?: (scriptUrl: string) => EngineWorker;
  handshakeTimeoutMs?: number;
  responseTimeoutMs?: number;
}

export interface WasmEngineCapabilities {
  /** True when the multi-threaded build runs (requires cross-origin isolation). */
  threads: boolean;
  /** e.g. `stockfish-19.0.1-lite-single`. */
  build: string;
  /** Value of the UCI `Threads` option set at load time. */
  threadCount: number;
}

export const MAX_DEFAULT_THREADS = 4;

/**
 * Multi-threaded `lite` build with `min(cores - 1, 4)` threads (at least 1) when the page is
 * cross-origin isolated (SharedArrayBuffer available); otherwise the single-threaded `lite-single`.
 */
export function selectBuild(env: { crossOriginIsolated: boolean; hardwareConcurrency: number }): {
  build: WasmBuild;
  threads: number;
} {
  if (!env.crossOriginIsolated) return { build: 'lite-single', threads: 1 };
  const cores = Number.isFinite(env.hardwareConcurrency) ? Math.floor(env.hardwareConcurrency) : 1;
  return { build: 'lite', threads: Math.max(1, Math.min(cores - 1, MAX_DEFAULT_THREADS)) };
}

function defaultEngineBaseUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}${__STOCKFISH_ENGINE__.dir}`, globalThis.location.href)
    .href;
}

/**
 * Stockfish (WASM) in a dedicated Web Worker, implementing the shared {@link Engine} interface.
 *
 * All scores yielded by {@link analyze} are from **White's point of view** (UCI reports them
 * relative to the side to move; the conversion happens in {@link UciSession}).
 */
export class WasmEngineClient implements Engine {
  private readonly options: WasmEngineClientOptions;
  private readonly selected: { build: WasmBuild; threads: number };
  private worker: EngineWorker | null = null;
  private session: UciSession | null = null;
  private loading: Promise<void> | null = null;
  private disposed = false;

  constructor(options: WasmEngineClientOptions = {}) {
    this.options = options;
    const auto = selectBuild({
      crossOriginIsolated: options.crossOriginIsolated ?? globalThis.crossOriginIsolated === true,
      hardwareConcurrency:
        options.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency ?? 1,
    });
    this.selected =
      options.build === 'lite-single'
        ? { build: 'lite-single', threads: 1 }
        : options.build === 'lite' && auto.build === 'lite-single'
          ? { build: 'lite', threads: 1 }
          : auto;
  }

  capabilities(): WasmEngineCapabilities {
    return {
      threads: this.selected.build === 'lite',
      build: `stockfish-${__STOCKFISH_ENGINE__.version}-${this.selected.build}`,
      threadCount: this.selected.threads,
    };
  }

  /** Engine `id name` after {@link load}. */
  get engineName(): string | undefined {
    return this.session?.engineName;
  }

  /** Spawns the worker and completes the UCI handshake. Idempotent; retryable after failure. */
  load(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Engine has been disposed'));
    this.loading ??= this.doLoad().catch((err: unknown) => {
      this.teardown();
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    const base = this.options.engineBaseUrl ?? defaultEngineBaseUrl();
    const scriptUrl = new URL(__STOCKFISH_ENGINE__.builds[this.selected.build], base).href;
    const create = this.options.createWorker ?? ((url: string): EngineWorker => new Worker(url));
    const worker = create(scriptUrl);
    this.worker = worker;

    let receiver: ((line: string) => void) | null = null;
    const transport: UciTransport = {
      send: (line) => worker.postMessage(line),
      onLine: (cb) => {
        receiver = cb;
      },
    };
    const session = new UciSession(transport, {
      handshakeTimeoutMs: this.options.handshakeTimeoutMs,
      responseTimeoutMs: this.options.responseTimeoutMs,
    });
    this.session = session;
    worker.onmessage = (ev) => {
      // The engine posts UCI output as strings; other payloads (download progress) are ignored.
      if (typeof ev.data === 'string') receiver?.(ev.data);
    };
    worker.onerror = (ev) => {
      ev.preventDefault?.();
      // An empty message means the script itself failed to load; "Uncaught [object Event]" is
      // what Emscripten produces when a pthread worker or the .wasm fails to load.
      const where = ev.filename ? ` (${ev.filename}:${ev.lineno})` : '';
      const detail = ev.message ? `${ev.message}${where}` : `failed to load ${scriptUrl}`;
      session.fail(new Error(`Stockfish worker error: ${detail}`));
    };
    worker.onmessageerror = () =>
      session.fail(new Error('Stockfish worker sent an unreadable message'));

    // Enqueue both synchronously so an analyze() issued right after load() runs after `Threads`
    // is set (setOptions would otherwise stop that search).
    await Promise.all([
      session.handshake(),
      this.selected.build === 'lite'
        ? session.setOptions({ Threads: this.selected.threads })
        : undefined,
    ]);
  }

  setOptions(options: Record<string, string | number | boolean>): Promise<void> {
    return this.requireSession().then((s) => s.setOptions(options));
  }

  /**
   * Analyzes `fen`; yields `info` updates (White-POV scores) and completes on `bestmove`.
   * Starting a new analysis stops the previous one (its iterator completes).
   */
  analyze(fen: string, opts: AnalyzeOptions = {}): AnalysisHandle {
    const session = this.session;
    if (!session || !this.loading) {
      const err = new Error(
        this.disposed ? 'Engine has been disposed' : 'Engine not loaded; call load() first',
      );
      return {
        bestMove: Promise.resolve(null),
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }),
      };
    }
    return session.analyze(fen, opts);
  }

  async stop(): Promise<void> {
    await this.session?.stop();
  }

  /** Terminates the worker; a running analysis iterator completes. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.teardown();
  }

  private teardown(): void {
    this.session?.close();
    this.worker?.terminate();
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
    }
    this.worker = null;
  }

  private async requireSession(): Promise<UciSession> {
    if (!this.loading)
      throw new Error(
        this.disposed ? 'Engine has been disposed' : 'Engine not loaded; call load() first',
      );
    await this.loading;
    if (!this.session) throw new Error('Engine has been disposed');
    return this.session;
  }
}
