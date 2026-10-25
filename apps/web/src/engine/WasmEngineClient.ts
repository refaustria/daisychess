import type { AnalyzeOptions, Engine } from '@daisychess/engine-core';
import {
  currentMemoryBudget,
  defaultThreadCount,
  memoryPagesCap,
  threadCap,
} from './memoryBudget';
import { UciSession, type AnalysisHandle, type UciTransport } from './UciSession';
import {
  classifyWasmFailure,
  disableWasm,
  markWasmDegraded,
  WasmEngineError,
  wasmHealth,
  wasmInstanceStarted,
  wasmInstanceStopped,
} from './wasmHealth';

/**
 * Browser builds shipped from the `stockfish` npm package (see vite-plugin-stockfish.ts):
 * `lite` (multi-threaded, small network), `lite-single` (single-threaded) and `full`
 * (multi-threaded with the full-strength network, ~99 MB; opt-in, ADR-010).
 */
export type WasmBuild = 'lite' | 'lite-single' | 'full';

/** Builds that run pthreads (need cross-origin isolation / SharedArrayBuffer). */
export const isMultiThreadBuild = (build: WasmBuild): boolean => build !== 'lite-single';

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
  /**
   * Force a build instead of auto-selecting (e.g. `lite-single` on an isolated page, or `full`).
   * A multi-threaded build forced on a non-isolated page gets 1 thread (and will fail to load).
   */
  build?: WasmBuild;
  /** URL of the directory holding the engine files (trailing slash). Defaults to the bundled one. */
  engineBaseUrl?: string;
  /** Worker factory; defaults to a classic `new Worker(url)` (the engine script is not an ES module). */
  createWorker?: (scriptUrl: string) => EngineWorker;
  handshakeTimeoutMs?: number;
  responseTimeoutMs?: number;
  /**
   * Thread cap of the multi-threaded builds (default threads and `setoption Threads`). Defaults to
   * the memory budget's cap on constrained devices (iOS/iPadOS, low `deviceMemory`; ADR-015), none
   * elsewhere.
   */
  maxThreads?: number;
  /**
   * Caps the shared memory's maximum (64 KiB pages) of the multi-threaded builds by starting them
   * through the memory shim (ADR-015). Defaults to the memory budget's cap on constrained devices
   * (512 MiB), none elsewhere (`0` = never).
   */
  maxMemoryPages?: number;
}

export interface WasmEngineCapabilities {
  /** True when a multi-threaded build runs (requires cross-origin isolation). */
  threads: boolean;
  /** e.g. `stockfish-19.0.1-lite-single`, `stockfish-19.0.1-full`. */
  build: string;
  /** Value of the UCI `Threads` option set at load time. */
  threadCount: number;
}

export { MAX_DEFAULT_THREADS } from './memoryBudget';

/**
 * Multi-threaded `lite` build with `min(cores - 1, 4)` threads (at least 1, at most `maxThreads`)
 * when the page is cross-origin isolated (SharedArrayBuffer available); otherwise the
 * single-threaded `lite-single`.
 */
export function selectBuild(
  env: { crossOriginIsolated: boolean; hardwareConcurrency: number },
  maxThreads?: number,
): {
  build: WasmBuild;
  threads: number;
} {
  if (!env.crossOriginIsolated) return { build: 'lite-single', threads: 1 };
  const threads = defaultThreadCount(env.hardwareConcurrency);
  return {
    build: 'lite',
    threads: maxThreads !== undefined ? Math.max(1, Math.min(threads, maxThreads)) : threads,
  };
}

/** The smallest configuration, used after a failure (ADR-015). */
const FALLBACK = { build: 'lite-single', threads: 1 } as const satisfies {
  build: WasmBuild;
  threads: number;
};

/**
 * URL of the worker script: the build itself, or for a multi-threaded build with a memory cap the
 * memory shim (`?engine=…&maxPages=…#<.wasm URL>`), which lowers the shared memory's maximum and
 * then runs the unchanged engine (the hash tells the engine where its .wasm is).
 */
export function engineScriptUrl(base: string, build: WasmBuild, maxMemoryPages?: number): string {
  const script = __STOCKFISH_ENGINE__.builds[build];
  if (!maxMemoryPages || !isMultiThreadBuild(build)) return new URL(script, base).href;
  const wasm = new URL(script.replace(/\.js$/, '.wasm'), base).href;
  const shim = new URL(__STOCKFISH_ENGINE__.memoryShim, base);
  shim.search = new URLSearchParams({ engine: script, maxPages: String(maxMemoryPages) }).toString();
  shim.hash = encodeURIComponent(wasm);
  return shim.href;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
  private selected: { build: WasmBuild; threads: number };
  private readonly maxThreads: number | undefined;
  private readonly maxMemoryPages: number | undefined;
  /** Runs the smallest configuration (after a failure in this session); no further downgrade. */
  private fallback = false;
  /** The handshake of the current worker completed (failures are search failures now). */
  private ready = false;
  private worker: EngineWorker | null = null;
  private session: UciSession | null = null;
  private loading: Promise<void> | null = null;
  private disposed = false;

  constructor(options: WasmEngineClientOptions = {}) {
    this.options = options;
    this.maxThreads =
      options.maxThreads !== undefined ? options.maxThreads : threadCap(currentMemoryBudget());
    this.maxMemoryPages =
      options.maxMemoryPages !== undefined
        ? options.maxMemoryPages || undefined
        : memoryPagesCap(currentMemoryBudget());
    const auto = selectBuild(
      {
        crossOriginIsolated: options.crossOriginIsolated ?? globalThis.crossOriginIsolated === true,
        hardwareConcurrency:
          options.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency ?? 1,
      },
      this.maxThreads,
    );
    const build = options.build ?? auto.build;
    this.selected =
      build === 'lite-single'
        ? { build, threads: 1 }
        : { build, threads: auto.build === 'lite-single' ? 1 : auto.threads };
    if (wasmHealth().degraded) {
      // An earlier instance ran out of memory (or crashed) in this session: start small.
      this.selected = { ...FALLBACK };
      this.fallback = true;
    }
  }

  capabilities(): WasmEngineCapabilities {
    return {
      threads: isMultiThreadBuild(this.selected.build),
      build: `stockfish-${__STOCKFISH_ENGINE__.version}-${this.selected.build}`,
      threadCount: this.selected.threads,
    };
  }

  /** Engine `id name` after {@link load}. */
  get engineName(): string | undefined {
    return this.session?.engineName;
  }

  /**
   * Spawns the worker and completes the UCI handshake. Idempotent; retryable after failure.
   *
   * Out of memory / worker failures (ADR-015): the first one in the session degrades every later
   * instance to `lite-single` and this load is retried once with it; a failure of that smaller
   * configuration disables the browser engine for the session (later loads reject at once without
   * spawning a worker, until `allowWasmRetry`).
   */
  load(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Engine has been disposed'));
    this.loading ??= this.loadWithRecovery().catch((err: unknown) => {
      this.teardown();
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  private async loadWithRecovery(): Promise<void> {
    const disabled = wasmHealth().disabled;
    if (disabled !== undefined) throw new WasmEngineError(disabled, 'worker', false);
    try {
      await this.doLoad();
      return;
    } catch (err) {
      const kind = classifyWasmFailure(err);
      if (!kind || this.disposed) throw err;
      if (this.fallback) {
        disableWasm(message(err));
        throw new WasmEngineError(message(err), kind, false);
      }
      markWasmDegraded(kind);
      this.teardown();
      this.selected = { ...FALLBACK };
      this.fallback = true;
    }
    try {
      await this.doLoad();
    } catch (err) {
      const kind = classifyWasmFailure(err);
      if (!kind || this.disposed) throw err;
      disableWasm(message(err));
      throw new WasmEngineError(message(err), kind, false);
    }
  }

  /** Classifies a fatal session error after the handshake (failure during a search). */
  private onFatal(err: Error): Error {
    if (!this.ready || this.disposed) return err;
    const kind = classifyWasmFailure(err);
    if (!kind) return err;
    if (this.fallback) {
      disableWasm(err.message);
      return new WasmEngineError(err.message, kind, false);
    }
    // A fresh instance (degraded to the single-threaded build) may succeed: callers recreate once.
    markWasmDegraded(kind);
    return new WasmEngineError(err.message, kind, true);
  }

  private async doLoad(): Promise<void> {
    this.ready = false;
    const base = this.options.engineBaseUrl ?? defaultEngineBaseUrl();
    const scriptUrl = engineScriptUrl(base, this.selected.build, this.maxMemoryPages);
    const create = this.options.createWorker ?? ((url: string): EngineWorker => new Worker(url));
    const worker = create(scriptUrl);
    this.worker = worker;
    wasmInstanceStarted();

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
      onFatal: (err) => this.onFatal(err),
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
      isMultiThreadBuild(this.selected.build)
        ? session.setOptions({ Threads: this.selected.threads })
        : undefined,
    ]);
    this.ready = true;
  }

  /** `Threads` is capped by `maxThreads` (memory budget) and ignored by the single-threaded build. */
  setOptions(options: Record<string, string | number | boolean>): Promise<void> {
    return this.requireSession().then((s) => {
      const opts = { ...options };
      if ('Threads' in opts) {
        const n = Math.max(1, Math.floor(Number(opts.Threads)) || 1);
        if (!isMultiThreadBuild(this.selected.build)) {
          delete opts.Threads;
        } else {
          opts.Threads = this.maxThreads !== undefined ? Math.min(n, this.maxThreads) : n;
          this.selected = { ...this.selected, threads: opts.Threads };
        }
      }
      return Object.keys(opts).length > 0 ? s.setOptions(opts) : undefined;
    });
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
    this.ready = false;
    this.session?.close();
    this.worker?.terminate();
    if (this.worker) {
      wasmInstanceStopped();
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
