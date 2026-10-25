import type { AnalyzeOptions, BestMove, Engine, EngineInfo } from '@daisychess/engine-core';
import { disableWasm, WasmEngineError } from './wasmHealth';
import { wasmSupport } from './wasmSupport';

/**
 * The one shared browser engine for batch work (ADR-015): the game review, the openings drill and
 * the engine of "Play vs Engine" lease the same WASM instance instead of each spawning their own
 * (each instance costs 60–160 MiB and iOS Safari answers the third with "Out of memory").
 *
 * - One holder at a time; later `acquire` calls wait in FIFO order (the drill waits for a running
 *   review, the review cancels nothing).
 * - The engine is created and loaded lazily on the first acquire and kept while leases come and go;
 *   it is disposed {@link POOL_IDLE_MS} after the last release (memory is freed once the user stops
 *   reviewing/drilling/playing), or at once by {@link EnginePool.trim}.
 * - A holder whose engine failed releases with `broken: true`: the instance is disposed and the
 *   next acquire creates a fresh one.
 */
export type PoolPurpose = 'review' | 'drill' | 'play';

export const POOL_IDLE_MS = 20_000;

export interface PoolLease {
  readonly engine: Engine;
  readonly purpose: PoolPurpose;
  /**
   * Hands the engine back (idempotent). `broken`: dispose it (failed engine). `restore`: UCI options
   * to set before the next holder gets it (e.g. strength limits of a game).
   */
  release(opts?: { broken?: boolean; restore?: Record<string, string | number | boolean> }): void;
}

export interface AcquireOptions {
  /** Aborts waiting (rejects with an `AbortError`); has no effect once the lease is granted. */
  signal?: AbortSignal;
  /** Called when the request has to wait for another holder (with that holder's purpose). */
  onWait?: (holder: PoolPurpose) => void;
}

export interface EnginePoolOptions {
  create: () => Engine | Promise<Engine>;
  idleMs?: number;
  /**
   * Why no engine can run in this browser at all (e.g. "wasm-simd is not enabled"), checked on
   * every `acquire`: the request is refused with a non-retryable `WasmEngineError` of kind
   * `unsupported` (and the browser engine disabled) without creating an engine.
   */
  unsupported?: () => string | undefined;
}

export interface EnginePoolStats {
  /** Engines created by this pool so far. */
  created: number;
  /** An engine instance exists (loading or loaded). */
  alive: boolean;
  holder: PoolPurpose | null;
  waiting: number;
}

interface Waiter {
  purpose: PoolPurpose;
  resolve(lease: PoolLease): void;
  reject(err: unknown): void;
  cleanup(): void;
}

const abortError = (): Error => Object.assign(new Error('Aborted'), { name: 'AbortError' });

export class EnginePool {
  private create: () => Engine | Promise<Engine>;
  private readonly idleMs: number;
  private readonly unsupported: (() => string | undefined) | undefined;
  private engine: Engine | null = null;
  private loading: Promise<Engine> | null = null;
  private holder: { purpose: PoolPurpose; id: number } | null = null;
  private readonly queue: Waiter[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on dispose/setFactory: leases and loads of an older generation are stale. */
  private generation = 0;
  private nextId = 0;
  private created = 0;
  /** Waits for `restore` options / `stop` of the previous holder before the next one starts. */
  private handover: Promise<void> = Promise.resolve();

  constructor(opts: EnginePoolOptions) {
    this.create = opts.create;
    this.idleMs = opts.idleMs ?? POOL_IDLE_MS;
    this.unsupported = opts.unsupported;
  }

  get stats(): EnginePoolStats {
    return {
      created: this.created,
      alive: this.engine !== null || this.loading !== null,
      holder: this.holder?.purpose ?? null,
      waiting: this.queue.length,
    };
  }

  /** Resolves with a lease once no one else holds the engine and it is loaded. */
  acquire(purpose: PoolPurpose, opts: AcquireOptions = {}): Promise<PoolLease> {
    if (opts.signal?.aborted) return Promise.reject(abortError());
    const unsupported = this.unsupported?.();
    if (unsupported !== undefined) {
      disableWasm(unsupported);
      return Promise.reject(new WasmEngineError(unsupported, 'unsupported', false));
    }
    if (!this.holder && this.queue.length === 0) return this.grant(purpose);
    return new Promise<PoolLease>((resolve, reject) => {
      const onAbort = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(abortError());
      };
      const waiter: Waiter = {
        purpose,
        resolve,
        reject,
        cleanup: () => opts.signal?.removeEventListener('abort', onAbort),
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
      if (this.holder) opts.onWait?.(this.holder.purpose);
    });
  }

  /** Replaces the factory (tests, other build) and disposes the current engine. */
  setFactory(create: () => Engine | Promise<Engine>): void {
    this.create = create;
    void this.dispose();
  }

  /** Disposes the engine now if nobody holds or waits for it (memory-constrained resume). */
  async trim(): Promise<void> {
    if (this.holder || this.queue.length > 0) return;
    this.clearIdle();
    await this.drop();
  }

  /**
   * Disposes the engine even while leased (tests, teardown): the holder's lease turns stale and
   * waiters are rejected.
   */
  async dispose(): Promise<void> {
    this.generation++;
    this.clearIdle();
    this.holder = null;
    for (const w of this.queue.splice(0)) {
      w.cleanup();
      w.reject(new Error('Engine pool disposed'));
    }
    this.handover = Promise.resolve();
    await this.drop();
  }

  // --- internals -------------------------------------------------------------------------------

  private grant(purpose: PoolPurpose): Promise<PoolLease> {
    const id = ++this.nextId;
    const gen = this.generation;
    this.holder = { purpose, id };
    this.clearIdle();
    const ready = this.handover.then(() => this.ensureEngine());
    return ready.then(
      (engine) => {
        if (gen !== this.generation) throw new Error('Engine pool disposed');
        return this.lease(engine, purpose, id, gen);
      },
      (err: unknown) => {
        // Load failed: the holder never got the engine; the next request starts a fresh one.
        if (gen === this.generation && this.holder?.id === id) {
          this.holder = null;
          void this.drop();
          this.next();
        }
        throw err;
      },
    );
  }

  private lease(engine: Engine, purpose: PoolPurpose, id: number, gen: number): PoolLease {
    let released = false;
    return {
      engine,
      purpose,
      release: (opts = {}) => {
        if (released) return;
        released = true;
        if (gen !== this.generation || this.holder?.id !== id) return;
        this.holder = null;
        if (opts.broken || this.engine !== engine) {
          void this.drop();
        } else {
          // The next holder starts on an idle engine with default options.
          this.handover = (async () => {
            try {
              await engine.stop();
              if (opts.restore && Object.keys(opts.restore).length > 0)
                await engine.setOptions(opts.restore);
            } catch {
              if (this.engine === engine) await this.drop();
            }
          })();
        }
        this.next();
      },
    };
  }

  private next(): void {
    const w = this.queue.shift();
    if (!w) {
      this.scheduleIdle();
      return;
    }
    w.cleanup();
    this.grant(w.purpose).then(w.resolve, w.reject);
  }

  private ensureEngine(): Promise<Engine> {
    if (this.engine && !this.loading) return Promise.resolve(this.engine);
    if (this.loading) return this.loading;
    const gen = this.generation;
    const p = (async () => {
      const e = await this.create();
      this.created++;
      if (gen !== this.generation) {
        void e.dispose().catch(() => undefined);
        throw new Error('Engine pool disposed');
      }
      this.engine = e;
      await e.load();
      return e;
    })();
    this.loading = p;
    p.then(
      () => {
        if (this.loading === p) this.loading = null;
      },
      () => {
        if (this.loading === p) this.loading = null;
      },
    );
    return p;
  }

  private async drop(): Promise<void> {
    const e = this.engine;
    this.engine = null;
    this.loading = null;
    if (e) await e.dispose().catch(() => undefined);
  }

  private scheduleIdle(): void {
    this.clearIdle();
    if (!this.engine && !this.loading) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.holder && this.queue.length === 0) void this.drop();
    }, this.idleMs);
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/**
 * True for failures after which a pooled engine must not be handed to the next holder: any search
 * error except a cancellation (a worker failure, a timeout or a broken UCI session alike).
 */
export function isEngineFailure(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name !== 'AbortError';
}

export interface PooledEngineOptions {
  purpose: PoolPurpose;
  onWait?: (waiting: boolean, holder?: PoolPurpose) => void;
  /** UCI options restored when a lease ends (e.g. `UCI_LimitStrength: false` after a game). */
  restore?: Record<string, string | number | boolean>;
}

type Handle = AsyncIterable<EngineInfo> & { readonly bestMove?: Promise<BestMove | null> };

/**
 * An {@link Engine} view of the pool for short searches (drill checks, engine moves): every
 * `analyze` leases the shared engine, applies the options set through this view, runs the search
 * and releases it again, so a review can run between two searches. `load()` warms the engine up,
 * `dispose()` only gives up the lease (the pooled engine stays for the next user).
 */
export class PooledEngine implements Engine {
  private options: Record<string, string | number | boolean> = {};
  private lease: PoolLease | null = null;
  private aborter = new AbortController();
  private disposed = false;

  constructor(
    private readonly pool: EnginePool,
    private readonly opts: PooledEngineOptions,
  ) {}

  async load(): Promise<void> {
    const lease = await this.take();
    this.give(lease);
  }

  /** Remembered and applied whenever this view gets the engine. */
  async setOptions(options: Record<string, string | number | boolean>): Promise<void> {
    this.options = { ...this.options, ...options };
  }

  analyze(fen: string, opts: AnalyzeOptions = {}): Handle {
    let resolveBest!: (b: BestMove | null) => void;
    const bestMove = new Promise<BestMove | null>((r) => (resolveBest = r));
    const take = () => this.take();
    const give = (lease: PoolLease, broken: boolean) => this.give(lease, broken);
    const options = () => this.options;
    async function* run(): AsyncGenerator<EngineInfo> {
      const lease = await take();
      let broken = false;
      try {
        const o = options();
        if (Object.keys(o).length > 0) await lease.engine.setOptions(o);
        const handle = lease.engine.analyze(fen, opts) as Handle;
        for await (const info of handle) yield info;
        resolveBest(handle.bestMove ? await handle.bestMove : null);
      } catch (err) {
        broken = isEngineFailure(err);
        throw err;
      } finally {
        resolveBest(null);
        give(lease, broken);
      }
    }
    const gen = run();
    return { bestMove, [Symbol.asyncIterator]: () => gen };
  }

  async stop(): Promise<void> {
    await this.lease?.engine.stop();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.aborter.abort();
    const l = this.lease;
    if (l) this.give(l);
  }

  private async take(): Promise<PoolLease> {
    if (this.disposed) throw new Error('Engine has been disposed');
    let waited = false;
    try {
      const lease = await this.pool.acquire(this.opts.purpose, {
        signal: this.aborter.signal,
        onWait: (holder) => {
          waited = true;
          this.opts.onWait?.(true, holder);
        },
      });
      if (this.disposed) {
        lease.release();
        throw new Error('Engine has been disposed');
      }
      this.lease = lease;
      return lease;
    } finally {
      if (waited) this.opts.onWait?.(false);
    }
  }

  private give(lease: PoolLease, broken = false): void {
    if (this.lease === lease) this.lease = null;
    lease.release({ broken, ...(this.opts.restore ? { restore: this.opts.restore } : {}) });
  }
}

/** The default browser engine: auto-selected build (`lite` on isolated pages), budget thread cap. */
const createWasmEngine = async (): Promise<Engine> => {
  const { WasmEngineClient } = await import('./WasmEngineClient');
  return new WasmEngineClient();
};

/** The app's shared batch engine (review, drill, play). */
export const browserEnginePool = new EnginePool({
  create: createWasmEngine,
  unsupported: () => wasmSupport().error,
});

/** Restores the production factory of {@link browserEnginePool} (tests). */
export function resetBrowserEngineFactory(): void {
  browserEnginePool.setFactory(createWasmEngine);
}
