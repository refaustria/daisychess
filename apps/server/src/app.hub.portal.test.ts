import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PROTOCOL_VERSION, type WelcomeMessage } from '@daisychess/engine-core';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { loadSqlite } from './review/ReviewStore.js';
import { LichessError } from './hub/portal/lichess.js';
import { fakeSpawner, registry, until } from '../test/helpers.js';
import { TestClient } from '../test/ws-client.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ORIGIN = 'https://hub.example';
const CSRF = { origin: ORIGIN, 'x-requested-with': 'daisychess-portal' };
const sqlite = await loadSqlite();

let app: FastifyInstance | null = null;
let nodeApp: FastifyInstance | null = null;
let dir: string | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) {
    expect(c.invalid).toEqual([]);
    c.ws.terminate();
  }
  await nodeApp?.close();
  nodeApp = null;
  await app?.close();
  app = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const fetchAccount = vi.fn(async (token: string) => {
  if (token === 'lio_bojan') return { id: 'bojan', username: 'Bojan' };
  throw new LichessError('rejected', 'nope');
});

async function startHub(env: Record<string, string> = {}) {
  dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-hubportal-app-'));
  app = await buildApp({
    config: loadConfig({
      ROLE: 'hub',
      HUB_STORE_PATH: path.join(dir, 'hub.sqlite'),
      REVIEW_STORE: 'off',
      HUB_ADMIN_LICHESS: 'bojan',
      PUBLIC_ORIGIN: ORIGIN,
      HUB_LOCAL_POOL_SHARE: '0',
      ...env,
    }),
    registry: registry({ id: 'fake', name: 'Fake', maxInstances: 2 }),
    spawnEngine: fakeSpawner(),
    logger: false,
    portal: { fetchAccount },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as AddressInfo).port;
}

async function portalLogin(): Promise<string> {
  const res = await app!.inject({
    method: 'POST',
    url: '/api/portal/login',
    headers: CSRF,
    payload: { lichessToken: 'lio_bojan' },
  });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

async function player(
  port: number,
  token?: string,
  ip = '198.51.100.7',
): Promise<{ c: TestClient; welcome: WelcomeMessage | null }> {
  const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws`, {
    headers: { origin: `http://127.0.0.1:${port}`, 'x-real-ip': ip },
  });
  clients.push(c);
  c.send({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test' },
    ...(token === undefined ? {} : { token }),
  });
  const first = await c.waitFor((m) => m.type === 'welcome' || m.type === 'error');
  return { c, welcome: first.type === 'welcome' ? (first as WelcomeMessage) : null };
}

describe('portal API outside ROLE=hub', () => {
  it('is not registered (404) on a standalone server', async () => {
    app = await buildApp({
      config: loadConfig({ REVIEW_STORE: 'off' }),
      registry: registry({ id: 'fake', name: 'Fake' }),
      spawnEngine: fakeSpawner(),
      logger: false,
    });
    for (const [method, url] of [
      ['GET', '/api/portal/me'],
      ['POST', '/api/portal/login'],
      ['GET', '/api/portal/nodes'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: CSRF,
        payload: method === 'POST' ? {} : undefined,
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe.skipIf(!sqlite)('ROLE=hub: portal end to end (M24-9)', () => {
  it('token minted in the portal analyses on local; revoking it closes the live connection', async () => {
    const port = await startHub();
    const cookie = await portalLogin();
    const created = await app!.inject({
      method: 'POST',
      url: '/api/portal/tokens',
      headers: { ...CSRF, cookie },
      payload: { nodeIds: ['local'], label: 'phone', tier: 'full' },
    });
    expect(created.statusCode).toBe(201);
    const { token, playerToken, setupLink } = created.json();
    expect(setupLink).toBe(`${ORIGIN}/#setup-token=${encodeURIComponent(playerToken)}`);

    const { c, welcome } = await player(port, playerToken);
    expect(welcome?.capabilities?.analysis).toBe(true);
    expect(welcome?.engines.map((e) => e.id)).toEqual(['fake']);
    // An infinite search keeps the session busy until the revoke.
    c.send({ type: 'analyze', sessionId: 's', searchId: 1, engine: 'fake', fen: FEN });
    await c.waitFor((m) => m.type === 'info');

    const listed = await app!.inject({
      method: 'GET',
      url: `/api/portal/tokens/${token.id}`,
      headers: { cookie },
    });
    expect(listed.json().token.connections).toBe(1);
    expect(listed.body).not.toContain(playerToken);

    const revoked = await app!.inject({
      method: 'POST',
      url: `/api/portal/tokens/${token.id}/revoke`,
      headers: { ...CSRF, cookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().closedConnections).toBe(1);
    expect(await c.waitClosed()).toBe(1008);
    expect(c.messages).toContainEqual({
      type: 'error',
      code: 'unauthorized',
      message: 'token revoked',
    });
    // The engine session was released.
    await until(() => app!.daisychess.pool.sessions === 0);

    // A reconnect is told why.
    const again = await player(port, playerToken);
    expect(again.welcome).toMatchObject({
      capabilities: { analysis: false },
      analysisDenied: 'revoked',
    });

    // Usage of the ended search was metered for the token.
    const usage = await app!.inject({
      method: 'GET',
      url: `/api/portal/tokens/${token.id}/usage`,
      headers: { cookie },
    });
    expect(usage.json().total.searches).toBe(1);
    expect(usage.json().byNode).toEqual([
      expect.objectContaining({ nodeId: 'local', searches: 1 }),
    ]);
  });

  it('a node created in the portal registers; revoking it closes its link and the node stops for good', async () => {
    const port = await startHub();
    const cookie = await portalLogin();
    const created = await app!.inject({
      method: 'POST',
      url: '/api/portal/nodes',
      headers: { ...CSRF, cookie },
      payload: { name: 'fast-box', pool: true, poolShare: 1 },
    });
    expect(created.statusCode).toBe(201);
    const { node, nodeToken } = created.json();
    const exit = vi.fn();
    nodeApp = await buildApp({
      config: loadConfig({
        ROLE: 'node',
        HUB_URL: `ws://127.0.0.1:${port}/link`,
        NODE_TOKEN: nodeToken,
        NODE_POOL: 'on',
      }),
      registry: registry({ id: 'nodefake', name: 'Node Fake' }),
      spawnEngine: fakeSpawner(),
      logger: false,
      node: { exit, reconnectMinMs: 50, reconnectMaxMs: 100 },
    });
    await nodeApp.ready();
    const hub = app!.daisychessHub;
    await until(() => hub.registry.get(node.id) !== undefined);
    const live = await app!.inject({
      method: 'GET',
      url: `/api/portal/nodes/${node.id}`,
      headers: { cookie },
    });
    expect(live.json().node).toMatchObject({
      status: 'online',
      live: { inPool: true, engines: ['nodefake'] },
    });
    expect(live.body).not.toContain(nodeToken);

    const revoked = await app!.inject({
      method: 'POST',
      url: `/api/portal/nodes/${node.id}/revoke`,
      headers: { ...CSRF, cookie },
    });
    expect(revoked.json()).toMatchObject({
      linkClosed: true,
      node: { revokedAt: expect.any(Number) },
    });
    await until(() => hub.registry.get(node.id) === undefined);
    // `revoked` is a fatal link end: the node exits non-zero instead of reconnecting.
    await until(() => exit.mock.calls.length > 0);
    expect(exit.mock.calls[0]![0]).not.toBe(0);
  });

  it('ADR-020 §4.1: 20 bad tokens in 10 min from one address → rate_limited and close; other addresses unaffected', async () => {
    const port = await startHub();
    const cookie = await portalLogin();
    const good = (
      await app!.inject({
        method: 'POST',
        url: '/api/portal/tokens',
        headers: { ...CSRF, cookie },
        payload: { nodeIds: ['local'] },
      })
    ).json().playerToken as string;
    const bad = `dc1_aaaaaaaa_${'b'.repeat(32)}`;
    for (let i = 1; i < 20; i++) {
      const { c, welcome } = await player(port, i % 2 ? bad : 'not-a-token', '198.51.100.20');
      expect(welcome?.analysisDenied).toBe('bad_token');
      c.ws.terminate();
    }
    // The 20th failure is answered rate_limited and the socket closes.
    const twentieth = await player(port, bad, '198.51.100.20');
    expect(twentieth.welcome).toBeNull();
    expect(twentieth.c.messages[0]).toMatchObject({ type: 'error', code: 'rate_limited' });
    expect(await twentieth.c.waitClosed()).toBe(1008);
    // From then on even a valid token is refused from that address (no more guessing)…
    const blocked = await player(port, good, '198.51.100.20');
    expect(blocked.welcome).toBeNull();
    expect(await blocked.c.waitClosed()).toBe(1008);
    // …while a hello without a token (rooms, review reads) still works.
    const noToken = await player(port, undefined, '198.51.100.20');
    expect(noToken.welcome?.analysisDenied).toBe('no_token');
    // Another address is not affected.
    const other = await player(port, good, '198.51.100.21');
    expect(other.welcome?.capabilities?.analysis).toBe(true);
  });

  it('portal routes are rate limited per address on the real app', async () => {
    await startHub();
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app!.inject({
        method: 'POST',
        url: '/api/portal/login',
        headers: { ...CSRF, 'x-real-ip': '198.51.100.30' },
        payload: { lichessToken: 'lio_wrong' },
      });
      if (res.statusCode === 429) limited++;
      else expect(res.statusCode).toBe(401);
    }
    expect(limited).toBe(2);
  });
});
