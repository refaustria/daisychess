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
import { utcDay } from './hub/store/HubStore.js';
import { fakeSpawner, registry, until } from '../test/helpers.js';
import { TestClient } from '../test/ws-client.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const LEGACY = 'owner-legacy-access-token';
const sqlite = await loadSqlite();

let hubApp: FastifyInstance | null = null;
let nodeApp: FastifyInstance | null = null;
let dir: string | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) {
    expect(c.invalid).toEqual([]);
    c.ws.terminate();
  }
  await nodeApp?.close();
  await hubApp?.close();
  nodeApp = null;
  hubApp = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function startHub(env: Record<string, string> = {}) {
  dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-hubroute-'));
  hubApp = await buildApp({
    config: loadConfig({
      ROLE: 'hub',
      HUB_STORE_PATH: path.join(dir, 'hub.sqlite'),
      REVIEW_STORE: 'off',
      ACCESS_TOKEN: LEGACY,
      HUB_LOCAL_NAME: 'referee',
      HUB_LOCAL_POOL_SHARE: '0',
      ...env,
    }),
    registry: registry({ id: 'hubfake', name: 'Hub Fake', maxInstances: 2 }),
    spawnEngine: fakeSpawner(),
    logger: false,
  });
  await hubApp.listen({ port: 0, host: '127.0.0.1' });
  const port = (hubApp.server.address() as AddressInfo).port;
  const hub = hubApp.daisychessHub;
  const operator = hub.tokens.upsertOperator({ lichessId: 'bojan', username: 'bojan' });
  const node = hub.tokens.mintNode({
    operatorId: operator.id,
    name: 'fast-box',
    pool: true,
    poolShare: 2,
  });
  return { hub, port, operatorId: operator.id, nodeToken: node.token, nodeId: node.record.id };
}

async function startNode(port: number, token: string) {
  nodeApp = await buildApp({
    config: loadConfig({
      ROLE: 'node',
      HUB_URL: `ws://127.0.0.1:${port}/link`,
      NODE_TOKEN: token,
      NODE_POOL: 'on',
      MAX_SESSIONS: '2',
    }),
    registry: registry({ id: 'fake', name: 'Node Fake', maxInstances: 2 }),
    spawnEngine: fakeSpawner(),
    logger: false,
    node: { exit: vi.fn(), reconnectMinMs: 5_000, reconnectMaxMs: 10_000 },
  });
  await nodeApp.ready();
}

async function player(
  port: number,
  token?: string,
): Promise<{ c: TestClient; welcome: WelcomeMessage }> {
  const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  clients.push(c);
  c.send({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test' },
    ...(token === undefined ? {} : { token }),
  });
  const welcome = await c.waitFor((m): m is WelcomeMessage => m.type === 'welcome');
  return { c, welcome };
}

const analyze = (sessionId: string, searchId: number, engine: string, extra: object = {}) => ({
  type: 'analyze',
  sessionId,
  searchId,
  engine,
  fen: FEN,
  ...extra,
});

describe.skipIf(!sqlite)('ROLE=hub: routing /ws players to nodes (M24-6)', () => {
  it('a dc1_ player token analyses on its node; usage is metered; node loss ends the search and closes 1012', async () => {
    const { hub, port, operatorId, nodeToken, nodeId } = await startHub();
    const minted = hub.tokens.mintToken({
      operatorId,
      kind: 'player',
      label: 'Anna',
      nodeIds: [nodeId],
      tier: 'standard',
    });
    // Node not connected yet: node_offline, rooms keep working.
    const offline = await player(port, minted.token);
    expect(offline.welcome).toMatchObject({
      engines: [],
      capabilities: { analysis: false, rooms: true },
      analysisDenied: 'node_offline',
    });

    await startNode(port, nodeToken);
    await until(() => hub.registry.get(nodeId)?.status != null);
    const { c, welcome } = await player(port, minted.token);
    expect(welcome.node).toEqual({ name: 'fast-box', operator: 'bojan', shared: false });
    expect(welcome.capabilities).toMatchObject({ analysis: true });
    expect(welcome.engines.map((e) => e.id)).toEqual(['fake']);
    expect(welcome.limits.maxSessionsPerConnection).toBe(2);

    c.send(analyze('s', 1, 'fake', { depth: 3 }));
    expect(await c.terminal('s', 1)).toMatchObject({ type: 'bestmove', reason: 'completed' });
    // The hub's own engine is not offered on this route.
    c.send(analyze('s', 2, 'hubfake', { depth: 3 }));
    expect(await c.terminal('s', 2)).toMatchObject({ type: 'error', code: 'unknown_engine' });
    await until(() =>
      hub.store
        .listUsage({ sinceDay: utcDay(Date.now()), tokenIds: [minted.record.id] })
        .some((u) => u.searches >= 1),
    );
    const usage = hub.store.listUsage({
      sinceDay: utcDay(Date.now()),
      tokenIds: [minted.record.id],
    });
    expect(usage).toEqual([expect.objectContaining({ nodeId, sessions: 1, searches: 2 })]);

    // An infinite search, then the node goes away: engine_crashed for it, then close 1012.
    c.send(analyze('t', 9, 'fake'));
    await c.waitFor((m) => m.type === 'info' && m.sessionId === 't');
    await nodeApp!.close();
    nodeApp = null;
    expect(await c.waitClosed()).toBe(1012);
    const after = c.messages.filter(
      (m) => m.type !== 'info' && 'sessionId' in m && m.sessionId === 't',
    );
    expect(after).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'engine_crashed',
        sessionId: 't',
        searchId: 9,
      }),
    ]);
    // The reconnecting client gets a fresh route: the node is offline now.
    await until(() => hub.registry.size === 0);
    expect((await player(port, minted.token)).welcome.analysisDenied).toBe('node_offline');

    const detail = (await hubApp!.inject({ method: 'GET', url: '/health/detail' })).json();
    expect(detail.router).toMatchObject({
      routes: { local: 0, private: 1, pool: 0 },
      denials: { node_offline: 2 },
    });
    const text = JSON.stringify(detail);
    expect(text).not.toContain(minted.token);
    expect(text).not.toContain(minted.record.id);
    expect(text).not.toContain('127.0.0.1');
  });

  it('the legacy ACCESS_TOKEN still analyses on local; denials carry the precise reason', async () => {
    const { hub, port, operatorId } = await startHub();
    const { c, welcome } = await player(port, LEGACY);
    expect(welcome).toMatchObject({
      node: { name: 'referee', shared: false },
      capabilities: { analysis: true, rooms: true },
      engines: [{ id: 'hubfake' }],
    });
    c.send(analyze('s', 1, 'hubfake', { depth: 3 }));
    expect(await c.terminal('s', 1)).toMatchObject({ type: 'bestmove' });
    await until(
      () => hub.store.listUsage({ sinceDay: utcDay(Date.now()), tokenIds: ['legacy'] }).length > 0,
    );
    expect(hub.store.listUsage({ sinceDay: utcDay(Date.now()), tokenIds: ['legacy'] })).toEqual([
      expect.objectContaining({ nodeId: 'local', sessions: 1, searches: 1 }),
    ]);
    expect(hubApp!.daisychess.ws.ipSessions.total).toBe(1);

    const pool = hub.tokens.mintToken({ operatorId, kind: 'pool' });
    const revoked = hub.tokens.mintToken({ operatorId, kind: 'pool' });
    hub.tokens.revokeToken(revoked.record.id);
    const expired = hub.tokens.mintToken({ operatorId, kind: 'pool', expiresAt: Date.now() + 50 });
    await new Promise((r) => setTimeout(r, 60));
    const denied: Record<string, unknown> = {};
    for (const [name, token] of [
      ['none', undefined],
      ['wrong legacy', 'not-the-token'],
      ['wrong secret', `${pool.token.slice(0, -1)}${pool.token.endsWith('a') ? 'b' : 'a'}`],
      ['unknown id', `dc1_aaaaaaaa_${'a'.repeat(32)}`],
      ['node token', `dcn_aaaaaaaa_${'a'.repeat(32)}`],
      ['revoked', revoked.token],
      ['expired', expired.token],
      ['pool, nothing in the pool', pool.token],
    ] as const) {
      denied[name] = (await player(port, token)).welcome.analysisDenied;
    }
    expect(denied).toEqual({
      none: 'no_token',
      'wrong legacy': 'bad_token',
      'wrong secret': 'bad_token',
      'unknown id': 'bad_token',
      'node token': 'bad_token',
      revoked: 'revoked',
      expired: 'expired',
      'pool, nothing in the pool': 'no_capacity',
    });
  });

  it('pool tokens: routed to a pool node (shared, no token id on the link), budget_exhausted once spent', async () => {
    const { hub, port, operatorId, nodeToken, nodeId } = await startHub({
      POOL_DAILY_BUDGET_MIN: '1',
    });
    await startNode(port, nodeToken);
    await until(() => hub.registry.get(nodeId)?.status != null);
    const pool = hub.tokens.mintToken({ operatorId, kind: 'pool', tier: 'small' });
    const { c, welcome } = await player(port, pool.token);
    expect(welcome.node).toEqual({ name: 'fast-box', operator: 'bojan', shared: true });
    expect(welcome.limits).toMatchObject({
      maxSessionsPerConnection: 1,
      maxThreads: 2,
      maxMovetimeMs: 60_000,
    });
    c.send(analyze('s', 1, 'fake', { depth: 2 }));
    expect(await c.terminal('s', 1)).toMatchObject({ type: 'bestmove' });
    // small tier: one session per token.
    c.send(analyze('t', 1, 'fake', { depth: 2 }));
    expect(await c.terminal('t', 1)).toMatchObject({ type: 'error', code: 'limit_exceeded' });

    // The budget runs out (e.g. on another connection): the next analyze is refused locally …
    hub.tokens.addEngineTime(pool.record.id, 60_000, { nodeId });
    c.send(analyze('s', 2, 'fake', { depth: 2 }));
    expect(await c.terminal('s', 2)).toMatchObject({
      type: 'error',
      code: 'no_capacity',
      message: 'daily pool budget exhausted',
    });
    // … and the next hello says why.
    expect((await player(port, pool.token)).welcome.analysisDenied).toBe('budget_exhausted');
  });
});
