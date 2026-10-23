import type { EngineConfig, EngineRegistry } from './registry.js';
import { UciProcess, withTimeout, UciTimeoutError } from './UciProcess.js';

export type SpawnEngine = (config: EngineConfig) => UciProcess;

export interface PoolLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}

const silentLogger: PoolLogger = { info() {}, warn() {}, error() {}, debug() {} };

export interface EnginePoolOptions {
  /** Global cap on concurrently leased instances (all engines). */
  maxSessions: number;
  /** Idle instances beyond `minWarm` are killed after this many ms. */
  idleMs: number;
  /** Instances per engine kept alive when idle. Default 1. */
  minWarm?: number;
  /** Timeout for stop/ucinewgame/isready when an instance is returned. Default 5 s. */
  resetTimeoutMs?: number;
  /** Creates (but does not start) a process for an engine. Default: `new UciProcess(binary)`. */
  spawn?: SpawnEngine;
  logger?: PoolLogger;
}

export interface Lease {
  readonly id: number;
  readonly engineId: string;
  readonly engine: UciProcess;
  readonly released: boolean;
}

export type AcquireResult =
  | { ok: true; lease: Lease }
  | { ok: false; code: 'unknown_engine' | 'no_capacity' | 'internal_error'; message: string };

export interface EngineStats {
  id: string;
  name: string;
  enabled: boolean;
  /** Leased instances. */
  busy: number;
  /** Started instances waiting for a lease. */
  idle: number;
}

type InstanceState = 'starting' | 'idle' | 'leased' | 'resetting' | 'dead';

interface Instance {
  readonly proc: UciProcess;
  state: InstanceState;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface EngineSlot {
  readonly config: EngineConfig;
  /** Every live or starting instance; its size never exceeds `config.maxInstances`. */
  readonly instances: Set<Instance>;
  /** LIFO: the most recently used instance is reused first so extra ones can go idle and be reaped. */
  readonly idle: Instance[];
  /** Instances being reset after release, with the promise that settles when they are back. */
  readonly returning: Map<Instance, Promise<void>>;
}

class LeaseImpl implements Lease {
  released = false;
  constructor(
    readonly id: number,
    readonly engineId: string,
    readonly instance: Instance,
  ) {}
  get engine(): UciProcess {
    return this.instance.proc;
  }
}

/**
 * Per-engine pools of native processes. A lease is exclusive use of one instance; capacity is
 * bounded per engine (`maxInstances`) and globally (`maxSessions`). Instances are spawned lazily,
 * reset on release (`stop`, `ucinewgame`, `isready`) or killed if unhealthy, and reaped when idle.
 */
export class EnginePool {
  private readonly slots = new Map<string, EngineSlot>();
  private readonly options: Required<Omit<EnginePoolOptions, 'logger' | 'spawn'>> & {
    spawn: SpawnEngine;
  };
  private readonly log: PoolLogger;
  private activeLeases = 0;
  private nextLeaseId = 1;
  private closed = false;

  constructor(registry: EngineRegistry, options: EnginePoolOptions) {
    for (const config of registry.engines) {
      this.slots.set(config.id, {
        config,
        instances: new Set(),
        idle: [],
        returning: new Map(),
      });
    }
    this.options = {
      maxSessions: options.maxSessions,
      idleMs: options.idleMs,
      minWarm: options.minWarm ?? 1,
      resetTimeoutMs: options.resetTimeoutMs ?? 5_000,
      spawn: options.spawn ?? ((cfg) => new UciProcess(cfg.binary)),
    };
    this.log = options.logger ?? silentLogger;
  }

  /** Number of leases currently held (global). */
  get sessions(): number {
    return this.activeLeases;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Leases an instance of `engineId`, spawning one if allowed. Never throws. */
  async acquire(engineId: string): Promise<AcquireResult> {
    if (this.closed) return { ok: false, code: 'no_capacity', message: 'server is shutting down' };
    const slot = this.slots.get(engineId);
    if (!slot || !slot.config.enabled) {
      return { ok: false, code: 'unknown_engine', message: `unknown engine "${engineId}"` };
    }
    if (this.activeLeases >= this.options.maxSessions) {
      return { ok: false, code: 'no_capacity', message: 'server session limit reached' };
    }
    // Reserve the global slot synchronously so concurrent acquires cannot overshoot.
    this.activeLeases++;
    try {
      for (;;) {
        const idle = this.takeIdle(slot);
        if (idle) return { ok: true, lease: this.lease(slot, idle) };
        if (slot.instances.size < slot.config.maxInstances) {
          const inst = await this.spawnInstance(slot);
          if (!inst) {
            this.activeLeases--;
            return {
              ok: false,
              code: 'internal_error',
              message: `engine "${engineId}" failed to start`,
            };
          }
          if (this.closed) {
            this.activeLeases--;
            await this.kill(slot, inst);
            return { ok: false, code: 'no_capacity', message: 'server is shutting down' };
          }
          return { ok: true, lease: this.lease(slot, inst) };
        }
        if (slot.returning.size > 0) {
          // An instance is being reset after release; it is back within resetTimeoutMs.
          await Promise.race(slot.returning.values());
          if (this.closed) {
            this.activeLeases--;
            return { ok: false, code: 'no_capacity', message: 'server is shutting down' };
          }
          continue;
        }
        this.activeLeases--;
        return {
          ok: false,
          code: 'no_capacity',
          message: `all ${slot.config.maxInstances} instance(s) of "${engineId}" are busy`,
        };
      }
    } catch (err) {
      this.activeLeases--;
      this.log.error({ err, engineId }, 'acquire failed');
      return { ok: false, code: 'internal_error', message: 'internal error' };
    }
  }

  /**
   * Returns a lease. Idempotent. The instance is reset in the background (the returned promise
   * settles when it is idle again or was killed because it was unhealthy).
   */
  release(lease: Lease): Promise<void> {
    if (!(lease instanceof LeaseImpl) || lease.released) return Promise.resolve();
    lease.released = true;
    this.activeLeases--;
    const inst = lease.instance;
    const slot = this.slots.get(lease.engineId);
    if (!slot) return Promise.resolve();
    if (inst.state === 'dead' || !inst.proc.alive) {
      this.remove(slot, inst);
      return Promise.resolve();
    }
    inst.state = 'resetting';
    const p = this.reset(slot, inst).finally(() => slot.returning.delete(inst));
    slot.returning.set(inst, p);
    return p;
  }

  stats(): EngineStats[] {
    return [...this.slots.values()].map((s) => {
      let busy = 0;
      for (const i of s.instances) if (i.state === 'leased') busy++;
      return {
        id: s.config.id,
        name: s.config.name,
        enabled: s.config.enabled,
        busy,
        idle: s.idle.length,
      };
    });
  }

  /** Total processes (starting, idle, leased, resetting) of one engine. */
  instanceCount(engineId: string): number {
    return this.slots.get(engineId)?.instances.size ?? 0;
  }

  /** Stops accepting leases and terminates every process. Safe to call twice. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const pending: Promise<unknown>[] = [];
    for (const slot of this.slots.values()) {
      // Resetting instances are killed too; their reset fails fast and settles.
      for (const inst of [...slot.instances]) pending.push(this.kill(slot, inst));
      pending.push(...slot.returning.values());
    }
    await Promise.allSettled(pending);
  }

  private lease(slot: EngineSlot, inst: Instance): LeaseImpl {
    inst.state = 'leased';
    const lease = new LeaseImpl(this.nextLeaseId++, slot.config.id, inst);
    this.log.debug({ engine: slot.config.id, pid: inst.proc.pid, lease: lease.id }, 'lease');
    return lease;
  }

  private takeIdle(slot: EngineSlot): Instance | null {
    while (slot.idle.length > 0) {
      const inst = slot.idle.pop()!;
      this.clearIdleTimer(inst);
      if (inst.proc.alive) return inst;
      this.remove(slot, inst);
    }
    return null;
  }

  private async spawnInstance(slot: EngineSlot): Promise<Instance | null> {
    const proc = this.options.spawn(slot.config);
    const inst: Instance = { proc, state: 'starting', idleTimer: null };
    slot.instances.add(inst);
    proc.onExit((exit) => {
      const wasState = inst.state;
      inst.state = 'dead';
      this.clearIdleTimer(inst);
      const i = slot.idle.indexOf(inst);
      if (i >= 0) slot.idle.splice(i, 1);
      slot.instances.delete(inst);
      if (!exit.expected) {
        this.log.warn(
          {
            engine: slot.config.id,
            pid: proc.pid,
            code: exit.code,
            signal: exit.signal,
            state: wasState,
            stderr: exit.stderr.slice(-5),
            err: exit.error?.message,
          },
          'engine process exited unexpectedly',
        );
      }
    });
    try {
      await proc.start();
      this.log.info(
        { engine: slot.config.id, pid: proc.pid, instances: slot.instances.size },
        'engine process started',
      );
      return inst;
    } catch (err) {
      this.log.error(
        { engine: slot.config.id, err: (err as Error).message, stderr: proc.exited?.stderr },
        'engine process failed to start',
      );
      await this.kill(slot, inst);
      return null;
    }
  }

  private async reset(slot: EngineSlot, inst: Instance): Promise<void> {
    const ms = this.options.resetTimeoutMs;
    try {
      await withTimeout(inst.proc.stop(), ms, () => new UciTimeoutError('stop', ms));
      await inst.proc.newGame(ms);
    } catch (err) {
      this.log.warn(
        { engine: slot.config.id, pid: inst.proc.pid, err: (err as Error).message },
        'engine instance unhealthy after release; killing it',
      );
      await this.kill(slot, inst);
      return;
    }
    if (this.closed || inst.state === 'dead') {
      await this.kill(slot, inst);
      return;
    }
    inst.state = 'idle';
    slot.idle.push(inst);
    this.armIdleTimer(slot, inst);
  }

  private armIdleTimer(slot: EngineSlot, inst: Instance): void {
    this.clearIdleTimer(inst);
    const t = setTimeout(() => {
      inst.idleTimer = null;
      if (inst.state !== 'idle') return;
      if (liveCount(slot) <= this.options.minWarm) return;
      const i = slot.idle.indexOf(inst);
      if (i >= 0) slot.idle.splice(i, 1);
      this.log.info({ engine: slot.config.id, pid: inst.proc.pid }, 'reaping idle engine process');
      void this.kill(slot, inst);
    }, this.options.idleMs);
    t.unref?.();
    inst.idleTimer = t;
  }

  private clearIdleTimer(inst: Instance): void {
    if (inst.idleTimer) clearTimeout(inst.idleTimer);
    inst.idleTimer = null;
  }

  /**
   * Marks an instance dead and unusable. It keeps counting against `maxInstances` until its
   * process has actually exited, so a dying process and its replacement never coexist beyond
   * the limit.
   */
  private remove(slot: EngineSlot, inst: Instance): void {
    inst.state = 'dead';
    this.clearIdleTimer(inst);
    const i = slot.idle.indexOf(inst);
    if (i >= 0) slot.idle.splice(i, 1);
    if (inst.proc.exited) slot.instances.delete(inst);
  }

  private async kill(slot: EngineSlot, inst: Instance): Promise<void> {
    this.remove(slot, inst);
    await inst.proc.dispose();
    slot.instances.delete(inst);
  }
}

function liveCount(slot: EngineSlot): number {
  let n = 0;
  for (const i of slot.instances) if (i.state !== 'dead') n++;
  return n;
}
