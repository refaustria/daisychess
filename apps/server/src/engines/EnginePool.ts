import { engineArgs, type EngineConfig, type EngineRegistry } from './registry.js';
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
  /**
   * Respawn backoff (docs/SECURITY.md): after the n-th consecutive crash of an engine, no new
   * instance of it is spawned for `min(backoffBaseMs * 2^(n-1), backoffMaxMs)` ± 20 %.
   * Defaults 500 ms and 30 s.
   */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** An instance alive this long resets its engine's crash counter. Default 60 s. */
  crashResetMs?: number;
  /** Consecutive crashes after which the engine is `degraded` (backoff pinned at max). Default 10. */
  maxConsecutiveCrashes?: number;
  /** Clock and randomness for the backoff (tests). Defaults `Date.now`, `Math.random`. */
  now?: () => number;
  random?: () => number;
  /**
   * Total live processes per engine `group` (ADR-019; e.g. `{ maia: 3 }` for the nine Maia
   * levels). At the cap, the least recently used idle instance of the group is killed to make
   * room; when every process of the group is leased, `acquire` answers `no_capacity`.
   * Groups without an entry are unbounded (per-engine `maxInstances` still applies).
   */
  groupLimits?: Record<string, number>;
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
  /** Consecutive crashes (unexpected exits or failed starts) since the last healthy run. */
  crashes: number;
  /** ISO time until which no new instance is spawned, or null. */
  backoffUntil: string | null;
  /** `crashes` reached `maxConsecutiveCrashes`; respawns are attempted every `backoffMaxMs`. */
  degraded: boolean;
  /** Process group (ADR-019), when the engine belongs to one. */
  group?: string;
}

/** Live processes of one engine group against its cap (`/health/detail`). */
export interface GroupStats {
  processes: number;
  max: number;
}

type InstanceState = 'starting' | 'idle' | 'leased' | 'resetting' | 'dead';

interface Instance {
  readonly proc: UciProcess;
  state: InstanceState;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Time the UCI handshake completed; null while starting. */
  startedAt: number | null;
  /** This instance's death was already counted as a crash. */
  crashCounted: boolean;
  /** Time it last became idle (group eviction picks the least recently used). */
  idleSince: number;
}

interface EngineSlot {
  readonly config: EngineConfig;
  /** Every live or starting instance; its size never exceeds `config.maxInstances`. */
  readonly instances: Set<Instance>;
  /** LIFO: the most recently used instance is reused first so extra ones can go idle and be reaped. */
  readonly idle: Instance[];
  /** Instances being reset after release, with the promise that settles when they are back. */
  readonly returning: Map<Instance, Promise<void>>;
  /** Consecutive crashes; reset by a healthy run (see {@link EnginePool.refreshCrashState}). */
  crashes: number;
  /** No spawn before this time (epoch ms); 0 = no backoff. */
  backoffUntil: number;
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
  private readonly options: Required<Omit<EnginePoolOptions, 'logger'>>;
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
        crashes: 0,
        backoffUntil: 0,
      });
    }
    this.options = {
      maxSessions: options.maxSessions,
      idleMs: options.idleMs,
      minWarm: options.minWarm ?? 1,
      resetTimeoutMs: options.resetTimeoutMs ?? 5_000,
      spawn:
        options.spawn ??
        ((cfg) =>
          new UciProcess(cfg.binary, { args: engineArgs(cfg), initOptions: cfg.initOptions })),
      groupLimits: options.groupLimits ?? {},
      backoffBaseMs: options.backoffBaseMs ?? 500,
      backoffMaxMs: options.backoffMaxMs ?? 30_000,
      crashResetMs: options.crashResetMs ?? 60_000,
      maxConsecutiveCrashes: options.maxConsecutiveCrashes ?? 10,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
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
          // Respawn backoff: refuse right away rather than holding the client's request.
          const waitMs = this.backoffRemaining(slot);
          if (waitMs > 0) {
            this.activeLeases--;
            return {
              ok: false,
              code: 'no_capacity',
              message: `engine "${engineId}" is restarting after a crash; retry in ${Math.ceil(waitMs / 1_000)} s`,
            };
          }
          // Group cap (ADR-019): make room by evicting the group's least recently used idle
          // process; if none is idle, every process of the group is in use.
          const group = slot.config.group;
          const groupMax = group !== undefined ? this.options.groupLimits[group] : undefined;
          if (group !== undefined && groupMax !== undefined && this.liveInGroup(group) >= groupMax) {
            const evicted = await this.evictIdleInGroup(group);
            if (!evicted || this.liveInGroup(group) >= groupMax) {
              this.activeLeases--;
              return {
                ok: false,
                code: 'no_capacity',
                message: `all ${groupMax} process(es) of engine group "${group}" are busy`,
              };
            }
          }
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
      this.refreshCrashState(s);
      let busy = 0;
      for (const i of s.instances) if (i.state === 'leased') busy++;
      return {
        id: s.config.id,
        name: s.config.name,
        enabled: s.config.enabled,
        busy,
        idle: s.idle.length,
        crashes: s.crashes,
        backoffUntil:
          s.backoffUntil > this.options.now() ? new Date(s.backoffUntil).toISOString() : null,
        degraded: s.crashes >= this.options.maxConsecutiveCrashes,
        ...(s.config.group !== undefined ? { group: s.config.group } : {}),
      };
    });
  }

  /** Live processes per capped engine group (ADR-019). */
  groupStats(): Record<string, GroupStats> {
    const out: Record<string, GroupStats> = {};
    for (const [group, max] of Object.entries(this.options.groupLimits)) {
      out[group] = { processes: this.liveInGroup(group), max };
    }
    return out;
  }

  /**
   * Tells the pool that the leased instance finished a search (its engine produced `bestmove`),
   * which proves the engine healthy and resets its crash counter. A running backoff is kept.
   */
  reportHealthy(lease: Lease): void {
    if (!(lease instanceof LeaseImpl) || lease.instance.state === 'dead') return;
    const slot = this.slots.get(lease.engineId);
    if (slot) this.resetCrashes(slot, 'search completed');
  }

  /** Total processes (starting, idle, leased, resetting) of one engine. */
  instanceCount(engineId: string): number {
    return this.slots.get(engineId)?.instances.size ?? 0;
  }

  /** Processes of every engine in `group` that have not exited yet (dying ones still count). */
  private liveInGroup(group: string): number {
    let n = 0;
    for (const slot of this.slots.values()) {
      if (slot.config.group === group) n += slot.instances.size;
    }
    return n;
  }

  /** Kills the least recently used idle instance of the group; false when none is idle. */
  private async evictIdleInGroup(group: string): Promise<boolean> {
    let oldest: { slot: EngineSlot; inst: Instance } | null = null;
    for (const slot of this.slots.values()) {
      if (slot.config.group !== group) continue;
      for (const inst of slot.idle) {
        if (inst.state !== 'idle') continue;
        if (!oldest || inst.idleSince < oldest.inst.idleSince) oldest = { slot, inst };
      }
    }
    if (!oldest) return false;
    this.log.info(
      { engine: oldest.slot.config.id, pid: oldest.inst.proc.pid, group },
      'evicting idle engine process to make room in its group',
    );
    await this.kill(oldest.slot, oldest.inst);
    return true;
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
    const inst: Instance = {
      proc,
      state: 'starting',
      idleTimer: null,
      startedAt: null,
      crashCounted: false,
      idleSince: 0,
    };
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
        if (!this.closed) this.recordCrash(slot, inst);
      }
    });
    try {
      await proc.start();
      inst.startedAt = this.options.now();
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
      if (!this.closed) this.recordCrash(slot, inst);
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
    inst.idleSince = this.options.now();
    slot.idle.push(inst);
    this.armIdleTimer(slot, inst);
  }

  // -------------------------------------------------------------------------------------------
  // Crash accounting and respawn backoff

  /** Milliseconds until the engine may spawn again (0 = now). */
  private backoffRemaining(slot: EngineSlot): number {
    this.refreshCrashState(slot);
    return Math.max(0, slot.backoffUntil - this.options.now());
  }

  /** A live instance that has been up for `crashResetMs` proves the engine healthy. */
  private refreshCrashState(slot: EngineSlot): void {
    if (slot.crashes === 0) return;
    const now = this.options.now();
    for (const inst of slot.instances) {
      if (
        inst.state !== 'dead' &&
        inst.startedAt !== null &&
        now - inst.startedAt >= this.options.crashResetMs
      ) {
        this.resetCrashes(slot, 'instance stayed up');
        return;
      }
    }
  }

  private resetCrashes(slot: EngineSlot, why: string): void {
    if (slot.crashes === 0) return;
    const wasDegraded = slot.crashes >= this.options.maxConsecutiveCrashes;
    (wasDegraded ? this.log.warn : this.log.info).call(
      this.log,
      { engine: slot.config.id, crashes: slot.crashes, why },
      wasDegraded ? 'engine recovered from degraded state' : 'engine crash counter reset',
    );
    slot.crashes = 0;
  }

  /** Counts an unexpected exit or failed start (once per instance) and arms the backoff. */
  private recordCrash(slot: EngineSlot, inst: Instance): void {
    if (inst.crashCounted) return;
    inst.crashCounted = true;
    const now = this.options.now();
    // The instance itself may have been healthy for long enough: this is a fresh first crash.
    if (inst.startedAt !== null && now - inst.startedAt >= this.options.crashResetMs) {
      this.resetCrashes(slot, 'instance stayed up');
    } else {
      this.refreshCrashState(slot);
    }
    slot.crashes++;
    const { backoffBaseMs, backoffMaxMs, maxConsecutiveCrashes } = this.options;
    const degraded = slot.crashes >= maxConsecutiveCrashes;
    const base = degraded
      ? backoffMaxMs
      : Math.min(backoffBaseMs * 2 ** Math.min(slot.crashes - 1, 30), backoffMaxMs);
    const delay = Math.round(base * (0.8 + 0.4 * this.options.random()));
    slot.backoffUntil = Math.max(slot.backoffUntil, now + delay);
    const fields = { engine: slot.config.id, crashes: slot.crashes, backoffMs: delay };
    if (slot.crashes === maxConsecutiveCrashes) {
      this.log.error(fields, 'engine degraded: too many consecutive crashes');
    } else {
      this.log.warn(fields, 'engine crashed; delaying respawn');
    }
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
