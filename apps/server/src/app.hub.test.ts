import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { loadSqlite } from './review/ReviewStore.js';
import type { AnalysisServerMessage } from './sessions/ClientSessions.js';
import { fakeSpawner, registry, until } from '../test/helpers.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const sqlite = await loadSqlite();

let hubApp: FastifyInstance | null = null;
let nodeApp: FastifyInstance | null = null;
let dir: string | null = null;

afterEach(async () => {
  await nodeApp?.close();
  await hubApp?.close();
  nodeApp = null;
  hubApp = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function startHub(env: Record<string, string> = {}) {
  dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-hubapp-'));
  hubApp = await buildApp({
    config: loadConfig({
      ROLE: 'hub',
      HUB_STORE_PATH: path.join(dir, 'hub.sqlite'),
      REVIEW_STORE: 'off',
      NODE_MIN_VERSION: '0.0.0',
      ...env,
    }),
    registry: registry({ id: 'fake', name: 'Fake' }),
    spawnEngine: fakeSpawner(),
    logger: false,
  });
  await hubApp.listen({ port: 0, host: '127.0.0.1' });
  const port = (hubApp.server.address() as AddressInfo).port;
  const hub = hubApp.daisychessHub;
  const operator = hub.tokens.upsertOperator({ lichessId: 'bojan', username: 'bojan' });
  const minted = hub.tokens.mintNode({
    operatorId: operator.id,
    name: 'fast-box',
    pool: true,
    poolShare: 2,
  });
  return { hub, port, nodeToken: minted.token, nodeId: minted.record.id };
}

async function startNode(port: number, token: string, exit = vi.fn()) {
  nodeApp = await buildApp({
    config: loadConfig({
      ROLE: 'node',
      HUB_URL: `ws://127.0.0.1:${port}/link`,
      NODE_TOKEN: token,
      NODE_POOL: 'on',
      MAX_SESSIONS: '2',
    }),
    registry: registry({ id: 'fake', name: 'Fake', maxInstances: 2 }),
    spawnEngine: fakeSpawner(),
    logger: false,
    node: { exit, reconnectMinMs: 50, reconnectMaxMs: 100 },
  });
  await nodeApp.ready();
  return exit;
}

describe.skipIf(!sqlite)('ROLE=hub: /link end to end with a real NodeLink', () => {
  it('registers a node and relays one search through RelaySessions', async () => {
    const { hub, port, nodeToken, nodeId } = await startHub();
    await startNode(port, nodeToken);
    await until(
      () => hub.registry.get(nodeId)?.status !== null && hub.registry.get(nodeId) !== undefined,
    );
    const entry = hub.registry.get(nodeId)!;
    expect(entry).toMatchObject({ name: 'fast-box', pool: true, poolShare: 2, maxSessions: 2 });
    expect(entry.engines.map((e) => e.id)).toEqual(['fake']);
    expect(hub.store.getNode(nodeId)?.lastSeenAt).toEqual(expect.any(Number));
    expect(hub.store.getNode(nodeId)?.lastVersion).toBe('0.0.0');

    const out: AnalysisServerMessage[] = [];
    const relay = entry.link.open(
      (m) => out.push(m),
      { ip: '198.51.100.9', id: 1 },
      {
        limits: entry.limits,
        shared: true,
        tier: 'standard',
      },
    );
    relay.handle({
      type: 'analyze',
      sessionId: 's1',
      searchId: 1,
      engine: 'fake',
      fen: FEN,
      depth: 4,
    });
    await until(() => out.some((m) => m.type === 'bestmove'));
    const bestIdx = out.findIndex((m) => m.type === 'bestmove');
    expect(bestIdx).toBe(out.length - 1);
    expect(out.slice(0, bestIdx).every((m) => m.type === 'info' && m.searchId === 1)).toBe(true);
    expect(out[bestIdx]).toMatchObject({ sessionId: 's1', searchId: 1, reason: 'completed' });
    expect(relay.openSearchCount).toBe(0);

    const detail = (await hubApp!.inject({ method: 'GET', url: '/health/detail' })).json();
    expect(detail).toMatchObject({
      role: 'hub',
      nodes: { nodes: [{ nodeId, name: 'fast-box', state: 'online', clients: 1 }] },
    });
    expect(JSON.stringify(detail)).not.toContain(nodeToken);

    // close() is acknowledged by the node with client.closed.
    await relay.close();
    expect(relay.state).toBe('closed');
    expect(entry.link.clients).toBe(0);

    // The node goes away: a running search ends with engine_crashed (once).
    const out2: AnalysisServerMessage[] = [];
    const relay2 = entry.link.open(
      (m) => out2.push(m),
      { ip: 'x', id: 2 },
      {
        limits: entry.limits,
        shared: false,
        tier: 'full',
      },
    );
    relay2.handle({ type: 'analyze', sessionId: 's', searchId: 7, engine: 'fake', fen: FEN });
    await until(() => out2.some((m) => m.type === 'info'));
    await nodeApp!.close();
    nodeApp = null;
    await relay2.lost;
    const terminals = out2.filter((m) => m.type !== 'info');
    expect(terminals).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'engine_crashed',
        sessionId: 's',
        searchId: 7,
      }),
    ]);
    await until(() => hub.registry.size === 0);
  });

  it('a revoked node exits non-zero; /ws still serves standalone analysis on the hub', async () => {
    const { hub, port, nodeToken, nodeId } = await startHub();
    hub.tokens.revokeNode(nodeId);
    const exit = await startNode(port, nodeToken);
    await until(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledWith(1);
    expect(hub.registry.size).toBe(0);
    expect(hub.link.stats().counters.refused).toEqual({ revoked: 1 });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    const welcome = await new Promise<{ type: string }>((resolve, reject) => {
      ws.on('message', (d) => resolve(JSON.parse(d.toString())));
      ws.on('error', reject);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1 })));
    });
    expect(welcome.type).toBe('welcome');
    ws.close();
  });
});
