import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeEnginePids, fakeSpawner, isRunning, registry, until } from '../../test/helpers.js';
import { EnginePool, type EnginePoolOptions, type Lease } from './EnginePool.js';

const pools: EnginePool[] = [];
function makePool(
  reg = registry({ id: 'fake', maxInstances: 2 }),
  opts: Partial<EnginePoolOptions> = {},
  flags: Record<string, string[]> = {},
): EnginePool {
  const pool = new EnginePool(reg, {
    maxSessions: 8,
    idleMs: 60_000,
    spawn: fakeSpawner(flags),
    ...opts,
  });
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(pools.splice(0).map((p) => p.shutdown()));
});

async function lease(pool: EnginePool, id = 'fake'): Promise<Lease> {
  const r = await pool.acquire(id);
  if (!r.ok) throw new Error(`acquire failed: ${r.code} ${r.message}`);
  return r.lease;
}

describe('EnginePool', () => {
  it('spawns lazily up to maxInstances and then reports no_capacity', async () => {
    const pool = makePool();
    expect(pool.instanceCount('fake')).toBe(0);
    const a = await lease(pool);
    const b = await lease(pool);
    expect(a.engine.pid).not.toBe(b.engine.pid);
    expect(pool.instanceCount('fake')).toBe(2);
    const c = await pool.acquire('fake');
    expect(c).toMatchObject({ ok: false, code: 'no_capacity' });
    expect(pool.stats()).toEqual([
      {
        id: 'fake',
        name: 'fake',
        enabled: true,
        busy: 2,
        idle: 0,
        crashes: 0,
        backoffUntil: null,
        degraded: false,
      },
    ]);
    expect(pool.sessions).toBe(2);
  });

  it('never exceeds maxInstances under concurrent acquires', async () => {
    const pool = makePool();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => pool.acquire('fake')));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok && r.code === 'no_capacity')).toHaveLength(3);
    expect(pool.instanceCount('fake')).toBe(2);
    expect(pool.sessions).toBe(2);
  });

  it('enforces the global session cap across engines', async () => {
    const pool = makePool(registry({ id: 'a' }, { id: 'b' }), { maxSessions: 1 });
    await lease(pool, 'a');
    expect(await pool.acquire('b')).toMatchObject({ ok: false, code: 'no_capacity' });
    expect(pool.instanceCount('b')).toBe(0);
  });

  it('rejects unknown and disabled engines', async () => {
    const pool = makePool(registry({ id: 'on' }, { id: 'off', enabled: false }));
    expect(await pool.acquire('nope')).toMatchObject({ ok: false, code: 'unknown_engine' });
    expect(await pool.acquire('off')).toMatchObject({ ok: false, code: 'unknown_engine' });
  });

  it('resets a released instance and reuses it; release is idempotent', async () => {
    const pool = makePool(registry({ id: 'fake', maxInstances: 1 }));
    const a = await lease(pool);
    const pid = a.engine.pid;
    // release while a search runs: the pool stops it
    const go = a.engine.go({ infinite: true });
    await pool.release(a);
    await expect(go).resolves.toBeTruthy();
    await pool.release(a);
    expect(pool.sessions).toBe(0);
    expect(pool.stats()[0]).toMatchObject({ busy: 0, idle: 1 });
    const b = await lease(pool);
    expect(b.engine.pid).toBe(pid);
  });

  it('waits for an instance that is being reset instead of failing', async () => {
    const pool = makePool(registry({ id: 'fake', maxInstances: 1 }), {}, {
      fake: ['--isready-delay=50'],
    });
    const a = await lease(pool);
    void pool.release(a); // resetting in the background
    const b = await lease(pool);
    expect(b.engine.pid).toBe(a.engine.pid);
  });

  it('kills an unhealthy instance on release and spawns a fresh one', async () => {
    const pool = makePool(registry({ id: 'fake', maxInstances: 1 }), { resetTimeoutMs: 200 }, {
      fake: ['--hang-on-newgame'],
    });
    const a = await lease(pool);
    const pid = a.engine.pid;
    await pool.release(a);
    expect(isRunning(pid)).toBe(false);
    expect(pool.instanceCount('fake')).toBe(0);
    const b = await lease(pool);
    expect(b.engine.pid).not.toBe(pid);
  });

  it('drops a crashed instance and respawns on the next acquire', async () => {
    const pool = makePool(registry({ id: 'fake', maxInstances: 1 }), { backoffBaseMs: 0 });
    const a = await lease(pool);
    const exited = new Promise((r) => a.engine.onExit(r));
    a.engine.send('crash');
    await exited;
    expect(pool.instanceCount('fake')).toBe(0);
    // capacity is still held by the lease until it is released
    expect(pool.sessions).toBe(1);
    await pool.release(a);
    expect(pool.sessions).toBe(0);
    expect(pool.stats()[0]).toMatchObject({ crashes: 1, degraded: false });
    const b = await lease(pool);
    expect(b.engine.alive).toBe(true);
    expect(b.engine.pid).not.toBe(a.engine.pid);
  });

  it('crash of an idle instance removes it from the idle list', async () => {
    const pool = makePool(registry({ id: 'fake', maxInstances: 1 }), { backoffBaseMs: 0 });
    const a = await lease(pool);
    await pool.release(a);
    const exited = new Promise((r) => a.engine.onExit(r));
    a.engine.send('crash');
    await exited;
    expect(pool.stats()[0]).toMatchObject({ busy: 0, idle: 0 });
    const b = await lease(pool);
    expect(b.engine.alive).toBe(true);
  });

  it('reaps idle instances beyond the warm minimum after ENGINE_IDLE_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pool = makePool(registry({ id: 'fake', maxInstances: 3 }), { idleMs: 1_000 });
    const leases = [await lease(pool), await lease(pool), await lease(pool)];
    await Promise.all(leases.map((l) => pool.release(l)));
    expect(pool.stats()[0]).toMatchObject({ idle: 3 });
    vi.advanceTimersByTime(999);
    expect(pool.stats()[0]).toMatchObject({ idle: 3 });
    vi.advanceTimersByTime(1);
    expect(pool.stats()[0]).toMatchObject({ idle: 1 });
    vi.useRealTimers();
    await until(() => pool.instanceCount('fake') === 1);
    expect(leases.filter((l) => l.engine.alive)).toHaveLength(1);
  });

  it('shutdown kills every process and refuses new leases', async () => {
    const pool = makePool(registry({ id: 'a', maxInstances: 2 }, { id: 'b' }));
    const a1 = await lease(pool, 'a');
    const a2 = await lease(pool, 'a');
    const b = await lease(pool, 'b');
    await pool.release(a2);
    void a1.engine.go({ infinite: true }).catch(() => {});
    const pids = [a1, a2, b].map((l) => l.engine.pid);
    expect((await fakeEnginePids()).filter((p) => pids.includes(p))).toHaveLength(3);
    await pool.shutdown();
    for (const pid of pids) expect(isRunning(pid)).toBe(false);
    expect(pool.instanceCount('a') + pool.instanceCount('b')).toBe(0);
    expect(await pool.acquire('a')).toMatchObject({ ok: false, code: 'no_capacity' });
    await pool.shutdown();
  });

  it('reports a binary that fails to start as internal_error and frees the slot', async () => {
    const spawnWithTimeout = new EnginePool(registry({ id: 'fake', maxInstances: 1 }), {
      maxSessions: 1,
      idleMs: 1_000,
      spawn: fakeSpawner({ fake: ['--no-uciok'] }, { handshakeTimeoutMs: 100 }),
    });
    pools.push(spawnWithTimeout);
    expect(await spawnWithTimeout.acquire('fake')).toMatchObject({ ok: false, code: 'internal_error' });
    expect(spawnWithTimeout.sessions).toBe(0);
    expect(spawnWithTimeout.instanceCount('fake')).toBe(0);
  });

  describe('respawn backoff', () => {
    /** Injected clock; random 0.5 makes the jitter factor exactly 1. */
    let t = 0;
    const clock = { now: () => t, random: () => 0.5 };

    async function crash(pool: EnginePool, l: Lease): Promise<void> {
      const exited = new Promise((r) => l.engine.onExit(r));
      l.engine.send('crash');
      await exited;
      await pool.release(l);
    }

    function backoffMs(pool: EnginePool): number {
      const until = pool.stats()[0]!.backoffUntil;
      return until === null ? 0 : Date.parse(until) - t;
    }

    it('grows exponentially, refuses spawns meanwhile and caps at backoffMaxMs', async () => {
      t = 1_000_000;
      const pool = makePool(registry({ id: 'fake', maxInstances: 1 }), {
        ...clock,
        backoffBaseMs: 500,
        backoffMaxMs: 4_000,
      });
      const expected = [500, 1_000, 2_000, 4_000, 4_000];
      for (const [i, delay] of expected.entries()) {
        await crash(pool, await lease(pool));
        expect(pool.stats()[0]).toMatchObject({ crashes: i + 1, busy: 0, idle: 0 });
        expect(backoffMs(pool)).toBe(delay);
        const refused = await pool.acquire('fake');
        expect(refused).toMatchObject({ ok: false, code: 'no_capacity' });
        expect(!refused.ok && refused.message).toMatch(/restarting after a crash/);
        expect(pool.sessions).toBe(0);
        expect(pool.instanceCount('fake')).toBe(0); // nothing was spawned
        t += delay - 1;
        expect(await pool.acquire('fake')).toMatchObject({ ok: false, code: 'no_capacity' });
        t += 1;
      }
      // after the last backoff a spawn is allowed again
      const ok = await lease(pool);
      expect(ok.engine.alive).toBe(true);
      expect(pool.stats()[0]!.backoffUntil).toBeNull();
    });

    it('jitters the delay by ±20 %', async () => {
      t = 0;
      let r = 0;
      const pool = makePool(registry({ id: 'fake', maxInstances: 1 }), {
        now: () => t,
        random: () => r,
        backoffBaseMs: 1_000,
      });
      await crash(pool, await lease(pool));
      expect(backoffMs(pool)).toBe(800);
      t += 800;
      r = 0.999_999;
      await crash(pool, await lease(pool));
      expect(backoffMs(pool)).toBe(2_400); // 2 000 × 1.2
    });

    it('serves an idle instance during backoff, but does not spawn', async () => {
      t = 0;
      const pool = makePool(registry({ id: 'fake', maxInstances: 2 }), clock);
      const a = await lease(pool);
      const b = await lease(pool);
      await pool.release(b);
      await crash(pool, a);
      expect(backoffMs(pool)).toBe(500);
      const again = await lease(pool);
      expect(again.engine.pid).toBe(b.engine.pid);
      expect(await pool.acquire('fake')).toMatchObject({ ok: false, code: 'no_capacity' });
      expect(pool.instanceCount('fake')).toBe(1);
    });

    it('marks the engine degraded after maxConsecutiveCrashes and pins the delay at the max', async () => {
      t = 0;
      const pool = makePool(registry({ id: 'fake', maxInstances: 1 }), {
        ...clock,
        backoffBaseMs: 100,
        backoffMaxMs: 10_000,
        maxConsecutiveCrashes: 3,
      });
      for (let i = 0; i < 4; i++) {
        await crash(pool, await lease(pool));
        t += backoffMs(pool);
      }
      t -= 10_000;
      expect(pool.stats()[0]).toMatchObject({ crashes: 4, degraded: true });
      expect(backoffMs(pool)).toBe(10_000); // 3rd and later crashes: max, not 100 × 2^n
    });

    it('resets after an instance stays up for crashResetMs (also from degraded)', async () => {
      t = 0;
      const pool = makePool(registry({ id: 'fake', maxInstances: 1 }), {
        ...clock,
        maxConsecutiveCrashes: 2,
        crashResetMs: 60_000,
      });
      await crash(pool, await lease(pool));
      t += 500;
      await crash(pool, await lease(pool));
      t += 30_000;
      expect(pool.stats()[0]).toMatchObject({ crashes: 2, degraded: true, backoffUntil: null });
      const healthy = await lease(pool);
      t += 59_999;
      expect(pool.stats()[0]).toMatchObject({ crashes: 2 });
      t += 1;
      expect(pool.stats()[0]).toMatchObject({ crashes: 0, degraded: false });
      // the next crash starts over at the base delay
      await crash(pool, healthy);
      expect(pool.stats()[0]).toMatchObject({ crashes: 1 });
      expect(backoffMs(pool)).toBe(500);
    });

    it('a long-lived instance that crashes counts as a first crash', async () => {
      t = 0;
      const pool = makePool(registry({ id: 'fake', maxInstances: 1 }), {
        ...clock,
        crashResetMs: 60_000,
      });
      await crash(pool, await lease(pool));
      t += 500;
      await crash(pool, await lease(pool));
      t += 1_000;
      const l = await lease(pool);
      t += 60_000;
      await crash(pool, l); // stats() was not called in between: the reset happens on the crash
      expect(pool.stats()[0]).toMatchObject({ crashes: 1 });
      expect(backoffMs(pool)).toBe(500);
    });

    it('reportHealthy (a completed search) resets the counter but keeps a running backoff', async () => {
      t = 0;
      const pool = makePool(registry({ id: 'fake', maxInstances: 2 }), clock);
      const a = await lease(pool);
      const b = await lease(pool);
      await crash(pool, a);
      expect(pool.stats()[0]).toMatchObject({ crashes: 1 });
      await b.engine.go({ depth: 1 });
      pool.reportHealthy(b);
      expect(pool.stats()[0]).toMatchObject({ crashes: 0 });
      expect(backoffMs(pool)).toBe(500);
      await pool.release(b);
      pool.reportHealthy(b); // stale lease: harmless
    });

    it('counts a failed start once and refuses the next spawn', async () => {
      t = 0;
      const pool = new EnginePool(registry({ id: 'fake', maxInstances: 1 }), {
        maxSessions: 1,
        idleMs: 1_000,
        ...clock,
        spawn: fakeSpawner({ fake: ['--no-uciok'] }, { handshakeTimeoutMs: 100 }),
      });
      pools.push(pool);
      expect(await pool.acquire('fake')).toMatchObject({ ok: false, code: 'internal_error' });
      expect(pool.stats()[0]).toMatchObject({ crashes: 1 });
      expect(await pool.acquire('fake')).toMatchObject({ ok: false, code: 'no_capacity' });
    });

    it('does not count exits caused by shutdown or by killing an unhealthy instance', async () => {
      t = 0;
      const pool = makePool(
        registry({ id: 'fake', maxInstances: 1 }),
        { ...clock, resetTimeoutMs: 200 },
        { fake: ['--hang-on-newgame'] },
      );
      await pool.release(await lease(pool)); // reset hangs → killed
      expect(pool.stats()[0]).toMatchObject({ crashes: 0, backoffUntil: null });
      await lease(pool);
      await pool.shutdown();
      expect(pool.stats()[0]).toMatchObject({ crashes: 0 });
    });
  });
});
