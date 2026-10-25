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
import { fakeSpawner, registry, until } from '../test/helpers.js';
import { TestClient } from '../test/ws-client.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const sqlite = await loadSqlite();

let hubApp: FastifyInstance | null = null;
let nodeApp: FastifyInstance | null = null;
let dir: string | null = null;
/** The spot-checker's clock (cool-downs are 24 h). */
let clock = Date.now();
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

async function startHub() {
  clock = Date.now();
  dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-hubspot-'));
  hubApp = await buildApp({
    config: loadConfig({
      ROLE: 'hub',
      HUB_STORE_PATH: path.join(dir, 'hub.sqlite'),
      REVIEW_STORE: 'off',
      HUB_LOCAL_POOL_SHARE: '0',
      SPOTCHECK_RATE: '1',
      // The fake engine rates a restricted move 25 cp lower; 10 cp makes that a disagreement.
      SPOTCHECK_TOLERANCE_CP: '10',
      SPOTCHECK_WINDOW: '3',
      SPOTCHECK_MIN_CHECKS: '3',
    }),
    registry: registry({ id: 'stockfish', name: 'Stockfish 19', maxInstances: 2 }),
    spawnEngine: fakeSpawner(),
    logger: false,
    spotCheck: { now: () => clock },
  });
  await hubApp.listen({ port: 0, host: '127.0.0.1' });
  const port = (hubApp.server.address() as AddressInfo).port;
  const hub = hubApp.daisychessHub;
  const operator = hub.tokens.upsertOperator({ lichessId: 'bojan', username: 'bojan' });
  const node = hub.tokens.mintNode({
    operatorId: operator.id,
    name: 'liar-box',
    pool: true,
    poolShare: 2,
  });
  return { hub, port, operatorId: operator.id, nodeToken: node.token, nodeId: node.record.id };
}

async function startNode(port: number, token: string, flags: string[]) {
  nodeApp = await buildApp({
    config: loadConfig({
      ROLE: 'node',
      HUB_URL: `ws://127.0.0.1:${port}/link`,
      NODE_TOKEN: token,
      NODE_POOL: 'on',
      MAX_SESSIONS: '2',
    }),
    registry: registry({ id: 'stockfish', name: 'Stockfish 17', maxInstances: 2 }),
    spawnEngine: fakeSpawner({ stockfish: flags }),
    logger: false,
    node: { exit: vi.fn(), reconnectMinMs: 5_000, reconnectMaxMs: 10_000 },
  });
  await nodeApp.ready();
}

async function player(port: number, token: string) {
  const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  clients.push(c);
  c.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, client: { name: 'test' }, token });
  const welcome = await c.waitFor((m): m is WelcomeMessage => m.type === 'welcome');
  return { c, welcome };
}

describe.skipIf(!sqlite)('ROLE=hub: pool spot-checks end to end (M24-12)', () => {
  it('a pool node with wrong moves: suspect (pool players moved off), back after the cool-down, pool-banned after the 3rd episode; private use keeps working', async () => {
    const { hub, port, operatorId, nodeToken, nodeId } = await startHub();
    await startNode(port, nodeToken, ['--bestmove=a2a3']);
    await until(() => hub.registry.get(nodeId)?.status != null);
    const pool = hub.tokens.mintToken({ operatorId, kind: 'pool', tier: 'standard' });
    const priv = hub.tokens.mintToken({
      operatorId,
      kind: 'player',
      label: 'own',
      nodeIds: [nodeId],
      tier: 'standard',
    });
    const search = (sessionId: string, searchId: number, depth = 12) => ({
      type: 'analyze',
      sessionId,
      searchId,
      engine: 'stockfish',
      fen: FEN,
      depth,
    });

    // Private searches are never sampled; the private connection lives through everything.
    const own = await player(port, priv.token);
    expect(own.welcome.node?.shared).toBe(false);
    own.c.send(search('p', 1));
    expect(await own.c.terminal('p', 1)).toMatchObject({ bestMove: { move: 'a2a3' } });

    /** Three wrong pool searches → one episode; the pool connection is then ended 1012. */
    const episode = async (first: boolean) => {
      const { c, welcome } = await player(port, pool.token);
      expect(welcome.node).toMatchObject({ name: 'liar-box', shared: true });
      if (first) {
        // Below the minimum depth: not eligible.
        c.send(search('s', 1, 5));
        await c.terminal('s', 1);
      }
      const started = hub.spotCheck!.stats().started;
      for (let i = 1; i <= 3; i++) {
        c.send(search('s', i + 1));
        expect(await c.terminal('s', i + 1)).toMatchObject({ bestMove: { move: 'a2a3' } });
        await until(
          () =>
            hub.spotCheck!.stats().running === 0 && hub.spotCheck!.stats().started === started + i,
        );
      }
      // Leaving the pool ends the node's pool connections (players reconnect elsewhere).
      expect(await c.waitClosed()).toBe(1012);
    };

    await episode(true);
    expect(hub.store.getNode(nodeId)).toMatchObject({ state: 'suspect', suspectCount: 1 });
    expect(hub.registry.get(nodeId)?.pool).toBe(false);
    expect((await player(port, pool.token)).welcome.analysisDenied).toBe('no_capacity');
    const detail = (await hubApp!.inject({ method: 'GET', url: '/health/detail' })).json();
    expect(detail.spotchecks).toMatchObject({
      offered: 4,
      eligible: 3,
      started: 3,
      disagreed: 3,
      reasons: { move_loss: 3 },
      reputation: { recorded: 3, suspected: 1 },
    });
    expect(JSON.stringify(detail.spotchecks)).not.toContain('rnbqkbnr');

    for (const n of [2, 3]) {
      // The cool-down ends: back in the pool on probation.
      clock = hub.store.getNode(nodeId)!.suspectUntil!;
      expect(hub.reputation.expireCooldowns(clock)).toBe(1);
      expect(hub.registry.get(nodeId)?.pool).toBe(true);
      await episode(false);
      expect(hub.store.getNode(nodeId)!.suspectCount).toBe(n);
    }
    // Third episode: permanently out of the pool, but neither suspect nor disabled.
    expect(hub.store.getNode(nodeId)).toMatchObject({
      state: 'normal',
      suspectCount: 3,
      poolBanReason: 'spot-check failures',
    });
    expect(hub.reputation.expireCooldowns(clock + 100 * 86_400_000)).toBe(0);
    expect(hub.registry.get(nodeId)?.pool).toBe(false);
    expect((await player(port, pool.token)).welcome.analysisDenied).toBe('no_capacity');
    expect(hub.spotCheck!.stats().reputation).toMatchObject({ suspected: 2, poolBanned: 1 });
    // The link and the private token keep working, on the same and on a new connection.
    expect(hub.registry.get(nodeId)?.state).toBe('online');
    own.c.send(search('p', 2));
    expect(await own.c.terminal('p', 2)).toMatchObject({ bestMove: { move: 'a2a3' } });
    expect(own.c.closeCode).toBeNull();
    const again = await player(port, priv.token);
    expect(again.welcome.node).toMatchObject({ name: 'liar-box', shared: false });
    again.c.send(search('q', 1));
    expect(await again.c.terminal('q', 1)).toMatchObject({ type: 'bestmove' });
  });

  it('an honest pool node agrees and stays in the pool', async () => {
    const { hub, port, operatorId, nodeToken, nodeId } = await startHub();
    await startNode(port, nodeToken, []);
    await until(() => hub.registry.get(nodeId)?.status != null);
    const pool = hub.tokens.mintToken({ operatorId, kind: 'pool', tier: 'standard' });
    const { c } = await player(port, pool.token);
    for (let i = 1; i <= 4; i++) {
      c.send({
        type: 'analyze',
        sessionId: 's',
        searchId: i,
        engine: 'stockfish',
        fen: FEN,
        depth: 12,
      });
      await c.terminal('s', i);
      await until(
        () => hub.spotCheck!.stats().running === 0 && hub.spotCheck!.stats().started === i,
      );
    }
    expect(hub.spotCheck!.stats()).toMatchObject({ agreed: 4, disagreed: 0 });
    expect(hub.store.getNode(nodeId)?.state).toBe('normal');
    expect(hub.registry.get(nodeId)?.pool).toBe(true);
  });
});
