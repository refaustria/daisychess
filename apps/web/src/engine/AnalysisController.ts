import type { AnalyzeOptions, BestMove, Engine, EngineInfo } from '@chesslab/engine-core';

/** What the controller needs from an engine: the shared {@link Engine} plus optional metadata. */
export interface AnalysisEngine extends Engine {
  /** `id name` reported by the engine (available after `load()`). */
  readonly engineName?: string;
  capabilities?(): EngineCapabilities;
  /** `bestMove` is provided by {@link WasmEngineClient}'s `AnalysisHandle`; optional for other engines. */
  analyze(
    fen: string,
    opts: AnalyzeOptions,
  ): AsyncIterable<EngineInfo> & { readonly bestMove?: Promise<BestMove | null> };
}

export interface EngineCapabilities {
  threads: boolean;
  build: string;
  threadCount: number;
}

export type AnalysisStatus = 'idle' | 'loading' | 'ready' | 'analysing' | 'error';
export type TerminalKind = 'checkmate' | 'stalemate';

export interface AnalysisSettings {
  /** Search depth limit; 0 = infinite. */
  depth: number;
  /** Number of principal variations, 1..5. */
  multipv: number;
  /** Engine threads; undefined = engine default (chosen at load time). */
  threads?: number;
}

export interface AnalysisCallbacks {
  onStatus(status: AnalysisStatus, error?: string): void;
  /** Engine loaded (name and capabilities known). */
  onEngine(info: { engineName?: string; capabilities?: EngineCapabilities }): void;
  /** The analysed position changed or analysis restarted: all lines for `fen` must be cleared. */
  onReset(fen: string, terminal: TerminalKind | null): void;
  /** A (White-POV) info line for the current `fen`. Infos of outdated positions are never forwarded. */
  onInfo(fen: string, info: EngineInfo): void;
  /** Search finished (depth limit reached). */
  onBestMove(fen: string, move: string | null): void;
}

export interface AnalysisControllerOptions {
  /** Replaceable at runtime via {@link AnalysisController.setEngineFactory}. */
  createEngine: () => AnalysisEngine | Promise<AnalysisEngine>;
  callbacks: AnalysisCallbacks;
  settings: AnalysisSettings;
  /** Classifies terminal positions, which are not sent to the engine. */
  classify?: (fen: string) => TerminalKind | null;
  /** Delay before a new position is analysed (keyboard navigation). Default 80 ms. */
  debounceMs?: number;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A fresh engine may succeed (browser engine degraded after running out of memory; ADR-015). */
const isRetryable = (err: unknown): boolean =>
  (err as { retryable?: unknown } | null)?.retryable === true;
/** No automatic recreation (browser engine disabled after its degraded retry failed too). */
const isFinal = (err: unknown): boolean =>
  (err as { retryable?: unknown } | null)?.retryable === false;

/**
 * Keeps one engine analysing the current position. Framework-free; the Zustand store
 * (`store/analysisStore.ts`) feeds it positions/settings and receives results via callbacks.
 *
 * - One engine instance, created and loaded lazily on the first enable.
 * - Every position change / restart bumps a generation counter; results of older generations
 *   are dropped, so infos of an outdated FEN never reach the callbacks.
 * - Position changes are debounced (trailing edge); enabling and settings changes start at once.
 * - A failure (load or search) disposes the engine and sets status `error`; {@link retry} or
 *   re-enabling creates a fresh engine.
 */
export class AnalysisController {
  private readonly opts: AnalysisControllerOptions;
  private readonly debounceMs: number;
  private settings: AnalysisSettings;
  private enabled = false;
  private disposed = false;
  private fen: string | null = null;
  private status: AnalysisStatus = 'idle';
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private engine: AnalysisEngine | null = null;
  /** Resolves with the loaded engine once all pending option changes are applied. */
  private enginePromise: Promise<AnalysisEngine> | null = null;
  /** Options as last sent to the engine (load time or setSettings). */
  private applied: { multipv: number; threads?: number } = { multipv: 1 };
  /** True once the current engine finished loading. */
  private loaded = false;
  /** Identifies the current engine instance; bumped when it is dropped. */
  private engineToken = 0;
  /** A retryable failure already recreated the engine once (reset when an engine loads). */
  private recreated = false;
  /** Error that must not be retried automatically (only {@link retry} tries again). */
  private finalError: string | null = null;

  constructor(opts: AnalysisControllerOptions) {
    this.opts = opts;
    this.settings = { ...opts.settings };
    this.debounceMs = opts.debounceMs ?? 80;
  }

  get currentStatus(): AnalysisStatus {
    return this.status;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Sets the position to analyse. Clears the lines immediately; the search starts after the debounce. */
  setPosition(fen: string): void {
    if (this.disposed || fen === this.fen) return;
    this.fen = fen;
    this.gen++;
    this.opts.callbacks.onReset(fen, this.classify(fen));
    if (!this.enabled || this.status === 'error') return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, this.debounceMs);
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.start();
      return;
    }
    this.clearTimer();
    this.gen++;
    if (this.fen !== null) this.opts.callbacks.onReset(this.fen, this.classify(this.fen));
    if (this.status !== 'error') this.setStatus('idle');
    const engine = this.engine;
    if (engine && this.status !== 'error') void engine.stop().catch(() => undefined);
  }

  setSettings(settings: AnalysisSettings): void {
    if (this.disposed) return;
    const prev = this.settings;
    this.settings = { ...settings };
    if (
      prev.depth === settings.depth &&
      prev.multipv === settings.multipv &&
      prev.threads === settings.threads
    ) {
      return;
    }
    if (this.enginePromise) {
      // Invalidate the running search before setOptions stops it in the engine.
      this.gen++;
      this.track(
        this.enginePromise.then(async (engine) => {
          const options = this.optionsToApply(engine);
          if (Object.keys(options).length > 0) await engine.setOptions(options);
          return engine;
        }),
      );
    }
    if (this.enabled && this.status !== 'error') this.start();
  }

  /** Recreates the engine after an error and resumes analysis (also after a final error). */
  retry(): void {
    if (this.disposed || !this.enabled) return;
    this.finalError = null;
    this.start();
  }

  /** Disposes the engine (e.g. on `pagehide`) without disabling; {@link resume} reloads it. */
  release(): void {
    this.clearTimer();
    this.gen++;
    this.dropEngine();
    if (!this.disposed && this.status !== 'error') this.setStatus('idle');
  }

  /**
   * Replaces the engine factory (backend switch): drops the current engine, clears the lines and,
   * while enabled, starts again with an engine from the new factory.
   */
  setEngineFactory(factory: () => AnalysisEngine | Promise<AnalysisEngine>): void {
    if (this.disposed) return;
    this.opts.createEngine = factory;
    this.clearTimer();
    this.gen++;
    this.dropEngine();
    if (this.fen !== null) this.opts.callbacks.onReset(this.fen, this.classify(this.fen));
    if (this.enabled) this.start();
    else if (this.status !== 'idle') this.setStatus('idle');
  }

  /** Restarts analysis after {@link release} (e.g. on `pageshow` from the bfcache). */
  resume(): void {
    if (!this.disposed && this.enabled) this.start();
  }

  dispose(): void {
    this.release();
    this.disposed = true;
  }

  // --- internals -------------------------------------------------------------------------------

  private start(): void {
    if (this.disposed || !this.enabled || this.fen === null) return;
    if (this.status === 'error' && this.finalError !== null) {
      // Re-enabling (e.g. after a review) must not spawn the failing engine again: show the error.
      this.setStatus('error', this.finalError);
      return;
    }
    this.clearTimer();
    const gen = ++this.gen;
    const fen = this.fen;
    if (this.status === 'error') this.dropEngine();
    const terminal = this.classify(fen);
    this.opts.callbacks.onReset(fen, terminal);
    const ready = this.ensureEngine();
    this.setStatus(!this.loaded ? 'loading' : terminal ? 'ready' : 'analysing');
    if (terminal) {
      // Nothing to search; make sure the engine is idle.
      void ready
        .then(async (engine) => {
          if (gen !== this.gen) return;
          this.setStatus('ready');
          await engine.stop();
        })
        .catch(() => undefined);
      return;
    }
    void this.search(gen, fen, ready);
  }

  private async search(gen: number, fen: string, ready: Promise<AnalysisEngine>): Promise<void> {
    let engine: AnalysisEngine;
    try {
      engine = await ready;
    } catch {
      return; // reported by track()
    }
    if (gen !== this.gen) return;
    const { depth, multipv } = this.settings;
    const handle = engine.analyze(fen, { ...(depth > 0 ? { depth } : {}), multipv });
    this.setStatus('analysing');
    try {
      for await (const info of handle) {
        // Leaving the loop stops a superseded search early (iterator return()).
        if (gen !== this.gen) return;
        this.opts.callbacks.onInfo(fen, info);
      }
      if (gen !== this.gen) return;
      const best = handle.bestMove ? await handle.bestMove : null;
      if (gen !== this.gen) return;
      this.opts.callbacks.onBestMove(fen, best?.move ?? null);
      this.setStatus('ready');
    } catch (err) {
      if (gen !== this.gen) return;
      this.fail(err);
    }
  }

  private ensureEngine(): Promise<AnalysisEngine> {
    if (this.enginePromise) return this.enginePromise;
    const token = ++this.engineToken;
    const p: Promise<AnalysisEngine> = (async () => {
      const engine = await this.opts.createEngine();
      if (token !== this.engineToken) {
        // Released while the factory ran.
        void engine.dispose().catch(() => undefined);
        throw new Error('Engine released');
      }
      this.engine = engine;
      await engine.load();
      this.applied = { multipv: 1 };
      const options = this.optionsToApply(engine);
      if (Object.keys(options).length > 0) await engine.setOptions(options);
      if (token === this.engineToken) {
        this.loaded = true;
        this.recreated = false;
        this.opts.callbacks.onEngine({
          engineName: engine.engineName,
          capabilities: engine.capabilities?.(),
        });
      }
      return engine;
    })();
    this.track(p);
    return p;
  }

  /** Installs `p` as the current engine promise and reports its failure (if still current). */
  private track(p: Promise<AnalysisEngine>): void {
    this.enginePromise = p;
    p.catch((err: unknown) => {
      if (this.enginePromise === p) this.fail(err);
    });
  }

  /** Option changes needed to bring the engine to the current settings (updates `applied`). */
  private optionsToApply(engine: AnalysisEngine): Record<string, number> {
    const options: Record<string, number> = {};
    if (this.settings.multipv !== this.applied.multipv) {
      options.MultiPV = this.settings.multipv;
      this.applied.multipv = this.settings.multipv;
    }
    const threads = this.settings.threads;
    const supportsThreads = engine.capabilities?.().threads ?? true;
    if (threads !== undefined && threads !== this.applied.threads && supportsThreads) {
      options.Threads = threads;
      this.applied.threads = threads;
    }
    return options;
  }

  private fail(err: unknown): void {
    if (this.disposed) return;
    this.gen++;
    this.clearTimer();
    this.dropEngine();
    if (isRetryable(err) && !this.recreated && this.enabled) {
      // Out of memory mid-search: one fresh (smaller) engine instead of an error.
      this.recreated = true;
      this.start();
      return;
    }
    this.finalError = isFinal(err) ? errorMessage(err) : null;
    this.setStatus('error', errorMessage(err));
  }

  private dropEngine(): void {
    const engine = this.engine;
    this.engine = null;
    this.enginePromise = null;
    this.engineToken++;
    this.loaded = false;
    this.applied = { multipv: 1 };
    if (engine) void engine.dispose().catch(() => undefined);
  }

  private setStatus(status: AnalysisStatus, error?: string): void {
    if (this.status === status && status !== 'error') return;
    this.status = status;
    this.opts.callbacks.onStatus(status, error);
  }

  private classify(fen: string): TerminalKind | null {
    return this.opts.classify?.(fen) ?? null;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
