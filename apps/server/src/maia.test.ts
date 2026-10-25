import { access, constants } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InfoMessage } from '@daisychess/engine-core';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { TestClient } from '../test/ws-client.js';

/**
 * Integration test against the real Lc0 build (`pnpm build-lc0`) with the Maia 1500 net
 * (`pnpm fetch-engines`, ADR-019). Skipped when either file is missing or with SKIP_LC0=1.
 */
const LC0 = fileURLToPath(new URL('../../../engines/lc0/lc0', import.meta.url));
const WEIGHTS = fileURLToPath(new URL('../../../engines/maia/maia-1500.pb.gz', import.meta.url));
const present = (file: string, mode: number) =>
  access(file, mode).then(
    () => true,
    () => false,
  );
const available =
  process.env.SKIP_LC0 !== '1' &&
  (await present(LC0, constants.X_OK)) &&
  (await present(WEIGHTS, constants.R_OK));

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe.skipIf(!available)('real Lc0 + Maia 1500 over /ws', () => {
  let app: FastifyInstance;
  let client: TestClient;

  beforeAll(async () => {
    app = await buildApp({
      config: loadConfig({ REVIEW_STORE: 'off' }),
      registry: {
        engines: [
          {
            id: 'maia-1500',
            name: 'Maia 1500',
            binary: LC0,
            weights: WEIGHTS,
            args: [
              '--backend=eigen',
              '--threads=1',
              '--minibatch-size=1',
              '--max-prefetch=0',
              '--nncache=1000',
            ],
            initOptions: { VerboseMoveStats: true },
            enabled: true,
            options: { Threads: 1 },
            maxInstances: 1,
            group: 'maia',
            style: 'human',
            rating: 1500,
            maxNodes: 1,
          },
        ],
      },
      logger: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    ({ client } = await TestClient.connectAndHello(`ws://127.0.0.1:${port}/ws`));
  });

  afterAll(async () => {
    client?.ws.terminate();
    await app?.close();
  });

  it('plays a legal policy move for the start position at 1 node within 2 s, with the policy', async () => {
    const t0 = Date.now();
    client.send({ type: 'analyze', sessionId: 'm', searchId: 1, engine: 'maia-1500', fen: START });
    const end = await client.terminal('m', 1, 2_000);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(end).toMatchObject({ type: 'bestmove', reason: 'completed' });
    const move = end.type === 'bestmove' ? end.bestMove?.move : undefined;
    const chess = new Chess(START);
    const legal = new Set(
      chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? '')),
    );
    expect(move).toBeDefined();
    expect(legal.has(move!)).toBe(true);
    const infos = client.messages.filter((m): m is InfoMessage => m.type === 'info');
    expect(infos.length).toBeGreaterThanOrEqual(1);
    const withPolicy = infos.at(-1)!.info;
    expect(withPolicy.nodes).toBe(1);
    expect(withPolicy.policy).toBeDefined();
    expect(withPolicy.policy!.length).toBe(5);
    for (const e of withPolicy.policy!) expect(legal.has(e.uci)).toBe(true);
    // most probable first, the best move is the most probable one, probabilities sum to <= 1
    const ps = withPolicy.policy!.map((e) => e.p);
    expect([...ps].sort((a, b) => b - a)).toEqual(ps);
    expect(withPolicy.policy![0]!.uci).toBe(move);
    expect(ps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1);
    expect(client.invalid).toEqual([]);
  });

  it('a second move on the warm process is fast and a terminal position yields bestMove null', async () => {
    const t0 = Date.now();
    client.send({
      type: 'analyze',
      sessionId: 'm',
      searchId: 2,
      engine: 'maia-1500',
      fen: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
    });
    const end = await client.terminal('m', 2, 2_000);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(end).toMatchObject({
      type: 'bestmove',
      bestMove: { move: expect.stringMatching(/^[a-h][1-8][a-h][1-8]$/) },
    });
    client.send({
      type: 'analyze',
      sessionId: 'm',
      searchId: 3,
      engine: 'maia-1500',
      fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
    });
    expect(await client.terminal('m', 3, 2_000)).toMatchObject({
      type: 'bestmove',
      bestMove: null,
    });
    const detail = (await app.inject({ method: 'GET', url: '/health/detail' })).json();
    expect(detail.processGroups.maia).toEqual({ processes: 1, max: 3 });
  });
});
