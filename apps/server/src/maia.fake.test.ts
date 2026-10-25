import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InfoMessage } from '@daisychess/engine-core';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { fakeSpawner, registry } from '../test/helpers.js';
import { TestClient } from '../test/ws-client.js';

/** Human-like engines (ADR-019) end to end with the Lc0-imitating fake engine. */
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const maiaRegistry = () =>
  registry(
    { id: 'fake', name: 'Fake Engine', maxInstances: 2 },
    ...[1100, 1500, 1900].map((rating) => ({
      id: `maia-${rating}`,
      name: `Maia ${rating}`,
      weights: `/nets/maia-${rating}.pb.gz`,
      args: ['--backend=eigen', '--threads=1'],
      initOptions: { VerboseMoveStats: true },
      options: { Threads: 1 },
      maxInstances: 3,
      group: 'maia',
      style: 'human' as const,
      rating,
      maxNodes: 1,
    })),
  );

const apps: FastifyInstance[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function start(env: Record<string, string> = {}) {
  const app = await buildApp({
    config: loadConfig({ REVIEW_STORE: 'off', ...env }),
    registry: maiaRegistry(),
    spawnEngine: fakeSpawner(
      {
        'maia-1100': ['--lc0'],
        'maia-1500': ['--lc0'],
        'maia-1900': ['--lc0'],
      },
      { initOptions: { VerboseMoveStats: true } },
    ),
    logger: false,
  });
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const { client, welcome } = await TestClient.connectAndHello(`ws://127.0.0.1:${port}/ws`);
  clients.push(client);
  return { app, client, welcome };
}

describe('Maia over /ws (fake Lc0)', () => {
  it('welcome announces style, rating and maxNodes for human engines only, and limits.maxNodes', async () => {
    const { welcome } = await start({ MAX_NODES: '500' });
    expect(welcome.limits.maxNodes).toBe(500);
    expect(welcome.engines).toEqual([
      { id: 'fake', name: 'Fake Engine', enabled: true, defaults: { threads: 1, hash: 16 } },
      ...[1100, 1500, 1900].map((rating) => ({
        id: `maia-${rating}`,
        name: `Maia ${rating}`,
        enabled: true,
        defaults: { threads: 1, hash: 16 },
        style: 'human',
        rating,
        maxNodes: 1,
      })),
    ]);
  });

  it('analyze without nodes runs the policy move: infos, then the last info with the policy, then bestmove', async () => {
    const { client } = await start();
    client.send({ type: 'analyze', sessionId: 'h', searchId: 1, engine: 'maia-1500', fen: START });
    const end = await client.terminal('h', 1);
    expect(end).toMatchObject({
      type: 'bestmove',
      bestMove: { move: 'e2e4' },
      reason: 'completed',
    });
    const infos = client.messages.filter((m): m is InfoMessage => m.type === 'info');
    expect(infos).toHaveLength(2);
    expect(infos[0]!.info).toMatchObject({ depth: 1, nodes: 1, pv: ['e2e4'] });
    expect(infos[0]!.info.policy).toBeUndefined();
    expect(infos[1]!.info).toMatchObject({ depth: 1, nodes: 1, pv: ['e2e4'] });
    expect(infos[1]!.info.policy).toEqual([
      { uci: 'e2e4', p: 0.5022 },
      { uci: 'd2d4', p: 0.2334 },
      { uci: 'c2c4', p: 0.0497 },
      { uci: 'g1f3', p: 0.0435 },
      { uci: 'e2e3', p: 0.0359 },
    ]);
    // the policy info precedes the terminal message
    expect(client.messages.indexOf(infos[1]!)).toBeLessThan(client.messages.indexOf(end));
    expect(client.invalid).toEqual([]);
  });

  it('a terminal position gives bestMove null and no policy', async () => {
    const { client } = await start();
    client.send({
      type: 'analyze',
      sessionId: 'h',
      searchId: 1,
      engine: 'maia-1500',
      fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 997',
    });
    const end = await client.terminal('h', 1);
    expect(end).toMatchObject({ type: 'bestmove', bestMove: null, reason: 'completed' });
    expect(client.messages.filter((m) => m.type === 'info')).toEqual([]);
  });

  it('enforces the per-engine node cap and the global maxNodes', async () => {
    const { client } = await start({ MAX_NODES: '100' });
    client.send({
      type: 'analyze',
      sessionId: 'h',
      searchId: 1,
      engine: 'maia-1500',
      fen: START,
      nodes: 2,
    });
    expect(await client.terminal('h', 1)).toMatchObject({
      type: 'error',
      code: 'limit_exceeded',
      message: 'nodes 2 exceeds the limit of 1 for engine "maia-1500"',
    });
    client.send({
      type: 'analyze',
      sessionId: 'h',
      searchId: 2,
      engine: 'maia-1500',
      fen: START,
      nodes: 1,
    });
    expect(await client.terminal('h', 2)).toMatchObject({
      type: 'bestmove',
      bestMove: { move: 'e2e4' },
    });
    client.send({
      type: 'analyze',
      sessionId: 's',
      searchId: 3,
      engine: 'fake',
      fen: START,
      nodes: 500,
    });
    expect(await client.terminal('s', 3)).toMatchObject({
      type: 'error',
      code: 'limit_exceeded',
      message: 'nodes 500 exceeds the server limit of 100',
    });
    // above the hard protocol bound: not even a valid message
    client.send({
      type: 'analyze',
      sessionId: 's',
      searchId: 4,
      engine: 'fake',
      fen: START,
      nodes: 10_001,
    });
    expect(await client.terminal('s', 4)).toMatchObject({ type: 'error', code: 'invalid_message' });
  });

  it('MAIA=off lists the Maia engines as disabled and rejects them', async () => {
    const { client, welcome } = await start({ MAIA: 'off' });
    expect(welcome.engines.map((e) => [e.id, e.enabled])).toEqual([
      ['fake', true],
      ['maia-1100', false],
      ['maia-1500', false],
      ['maia-1900', false],
    ]);
    client.send({ type: 'analyze', sessionId: 'h', searchId: 1, engine: 'maia-1500', fen: START });
    expect(await client.terminal('h', 1)).toMatchObject({ type: 'error', code: 'unknown_engine' });
  });

  it('/health/detail shows the Maia group cap and per-engine group', async () => {
    const { app, client } = await start({ MAIA_MAX_PROCESSES: '2' });
    client.send({ type: 'analyze', sessionId: 'a', searchId: 1, engine: 'maia-1100', fen: START });
    client.send({ type: 'analyze', sessionId: 'b', searchId: 1, engine: 'maia-1900', fen: START });
    await client.terminal('a', 1);
    await client.terminal('b', 1);
    const detail = (await app.inject({ method: 'GET', url: '/health/detail' })).json();
    expect(detail.processGroups).toEqual({ maia: { processes: 2, max: 2 } });
    expect(detail.engines.find((e: { id: string }) => e.id === 'maia-1100')).toMatchObject({
      group: 'maia',
      busy: 1,
    });
    expect(detail.engines.find((e: { id: string }) => e.id === 'fake').group).toBeUndefined();
  });
});
