import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { FakeHub } from '../test/fake-hub.js';
import { fakeSpawner, registry, until } from '../test/helpers.js';

const TOKEN = `dcn_abcdefgh_${'a'.repeat(32)}`;

let app: FastifyInstance | null = null;
let hub: FakeHub | null = null;
afterEach(async () => {
  await app?.close();
  await hub?.close();
  app = null;
  hub = null;
});

describe('ROLE=node app', () => {
  it('connects to the hub on ready, serves /health and /health/detail with the link state, no /ws', async () => {
    hub = await FakeHub.start();
    const exit = vi.fn();
    app = await buildApp({
      config: loadConfig({
        ROLE: 'node',
        HUB_URL: hub.url,
        NODE_TOKEN: TOKEN,
        NODE_NAME: 'box',
        MAX_SESSIONS: '3',
        NODE_MAX_SESSIONS: '2',
        NODE_POOL: 'on',
      }),
      registry: registry({ id: 'fake', name: 'Fake', maxInstances: 2 }),
      spawnEngine: fakeSpawner(),
      logger: false,
      node: { exit },
    });
    expect(app.hasDecorator('daisychess')).toBe(false);
    await app.ready();
    const l = await hub.link(0);
    const hello = await l.waitFor('node.hello');
    expect(hello).toMatchObject({
      nodeToken: TOKEN,
      maxSessions: 2,
      pool: true,
      node: { version: '0.0.0' },
      engines: [{ id: 'fake', name: 'Fake', enabled: true }],
    });
    l.welcome({ nodeId: 'abcdefgh', name: 'fast-box' });
    await l.waitFor('node.status');

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toEqual({ status: 'ok', version: '0.0.0' });
    const detail = (await app.inject({ method: 'GET', url: '/health/detail' })).json();
    expect(detail).toMatchObject({
      status: 'ok',
      role: 'node',
      sessions: 0,
      engines: [{ id: 'fake', busy: 0 }],
      link: {
        state: 'connected',
        connected: true,
        nodeId: 'abcdefgh',
        name: 'fast-box',
        localName: 'box',
        sessions: 0,
        maxSessions: 2,
        clients: 0,
        counters: { unknownCid: 0 },
      },
    });
    expect(detail.link.lastPongAt).toEqual(expect.any(String));
    expect(JSON.stringify(detail)).not.toContain(TOKEN);
    expect((await app.inject({ method: 'GET', url: '/ws' })).statusCode).toBe(404);

    // A relayed search runs on this node's pool.
    l.send({
      type: 'client.open',
      cid: 'c1',
      limits: app.daisychessNode.config.limits,
      shared: false,
      tier: 'full',
    });
    l.send({
      type: 'client.msg',
      cid: 'c1',
      msg: {
        type: 'analyze',
        sessionId: 's',
        searchId: 1,
        engine: 'fake',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        depth: 3,
      },
    });
    await l.waitFor('client.msg', (m) => m.msg.type === 'bestmove');
    await until(async () => {
      const d = (await app!.inject({ method: 'GET', url: '/health/detail' })).json();
      return d.link.clients === 1 && d.link.sessions === 1;
    });

    // Closing the app closes the link (no reconnect) and the pool.
    await app.close();
    app = null;
    expect((await l.waitClosed()).code).toBe(1001);
    expect(exit).not.toHaveBeenCalled();
  });
});
