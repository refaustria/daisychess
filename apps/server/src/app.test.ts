import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { fakeSpawner, registry } from '../test/helpers.js';

describe('GET /health', () => {
  it('returns status, version, per-engine pool stats and sessions', async () => {
    const app = await buildApp({
      config: loadConfig({}),
      registry: registry(
        { id: 'fake', name: 'Fake', maxInstances: 2 },
        { id: 'off', enabled: false },
      ),
      spawnEngine: fakeSpawner(),
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      version: '0.0.0',
      engines: [
        { id: 'fake', name: 'Fake', enabled: true, busy: 0, idle: 0 },
        { id: 'off', name: 'off', enabled: false, busy: 0, idle: 0 },
      ],
      sessions: 0,
    });
    await app.close();
  });

  it('disables enabled engines whose binary is missing', async () => {
    const app = await buildApp({
      config: loadConfig({}),
      registry: registry({ id: 'ghost', binary: '/nonexistent/stockfish' }),
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ engines: [{ id: 'ghost', enabled: false }] });
    await app.close();
  });
});
