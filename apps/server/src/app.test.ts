import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { fakeSpawner, registry } from '../test/helpers.js';

const EMPTY = { busy: 0, idle: 0, crashes: 0, backoffUntil: null, degraded: false };

describe('GET /health', () => {
  it('returns only status and version; /health/detail adds pool stats, sessions and connections', async () => {
    const app = await buildApp({
      config: loadConfig({ REVIEW_STORE: 'off' }),
      registry: registry(
        { id: 'fake', name: 'Fake', maxInstances: 2 },
        { id: 'off', enabled: false },
      ),
      spawnEngine: fakeSpawner(),
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: '0.0.0' });
    const detail = await app.inject({ method: 'GET', url: '/health/detail' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({
      status: 'ok',
      version: '0.0.0',
      engines: [
        { ...EMPTY, id: 'fake', name: 'Fake', enabled: true },
        { ...EMPTY, id: 'off', name: 'off', enabled: false },
      ],
      processGroups: { maia: { processes: 0, max: 3 } },
      sessions: 0,
      connections: 0,
      clientAddresses: 0,
      rooms: { rooms: 0, waiting: 0, playing: 0, finished: 0, members: 0 },
      reviewStore: expect.objectContaining({ reviews: 0, positions: 0 }),
    });
    await app.close();
  });

  it('disables enabled engines whose binary is missing', async () => {
    const app = await buildApp({
      config: loadConfig({ REVIEW_STORE: 'off' }),
      registry: registry({ id: 'ghost', binary: '/nonexistent/stockfish' }),
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/health/detail' });
    expect(res.json()).toMatchObject({ engines: [{ id: 'ghost', enabled: false }] });
    await app.close();
  });
});
