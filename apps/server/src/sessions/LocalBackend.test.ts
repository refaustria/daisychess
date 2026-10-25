import { describe, expect, it } from 'vitest';
import { EnginePool } from '../engines/EnginePool.js';
import { LocalBackend } from './LocalBackend.js';
import { fakeSpawner, registry } from '../../test/helpers.js';

describe('LocalBackend', () => {
  it('leases from the pool, reports health and returns leases (idempotently)', async () => {
    const pool = new EnginePool(registry({ id: 'fake', maxInstances: 2 }), {
      maxSessions: 1,
      idleMs: 60_000,
      spawn: fakeSpawner(),
    });
    const backend = new LocalBackend(pool);
    try {
      expect(backend.health()).toEqual({ available: true, sessions: 0 });
      const res = await backend.acquire('fake', { peerId: 1, sessionId: 's' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.lease.engineId).toBe('fake');
      expect(backend.health().sessions).toBe(1);
      const full = await backend.acquire('fake', { peerId: 2, sessionId: 's' });
      expect(full).toMatchObject({ ok: false, code: 'no_capacity' });
      const unknown = await backend.acquire('nope', { peerId: 1, sessionId: 't' });
      expect(unknown).toMatchObject({ ok: false, code: 'unknown_engine' });
      backend.reportHealthy(res.lease);
      await backend.release(res.lease);
      await backend.release(res.lease);
      expect(backend.health().sessions).toBe(0);
    } finally {
      await pool.shutdown();
    }
    expect(backend.health().available).toBe(false);
  });
});
