import { access, constants } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InfoMessage } from '@chesslab/engine-core';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { TestClient } from '../test/ws-client.js';

/**
 * Integration test against the real native Stockfish from `pnpm fetch-engines`.
 * Skipped when the binary is missing (CI) or with SKIP_STOCKFISH=1.
 */
const STOCKFISH = fileURLToPath(new URL('../../../engines/stockfish/stockfish', import.meta.url));
const available =
  process.env.SKIP_STOCKFISH !== '1' &&
  (await access(STOCKFISH, constants.X_OK).then(
    () => true,
    () => false,
  ));

describe.skipIf(!available)('real Stockfish over /ws', () => {
  let app: FastifyInstance;
  let client: TestClient;

  beforeAll(async () => {
    app = await buildApp({
      config: loadConfig({}),
      registry: {
        engines: [
          {
            id: 'stockfish',
            name: 'Stockfish',
            binary: STOCKFISH,
            enabled: true,
            options: { Threads: 1, Hash: 16 },
            maxInstances: 1,
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

  it('analyses the start position to depth 12', async () => {
    client.send({
      type: 'analyze',
      sessionId: 'sf',
      searchId: 1,
      engine: 'stockfish',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      depth: 12,
    });
    const end = await client.terminal('sf', 1, 30_000);
    expect(end).toMatchObject({ type: 'bestmove', reason: 'completed' });
    expect(end.type === 'bestmove' && end.bestMove?.move).toMatch(/^[a-h][1-8][a-h][1-8]$/);
    const infos = client.messages.filter((m): m is InfoMessage => m.type === 'info');
    expect(Math.max(...infos.map((i) => i.info.depth))).toBe(12);
    expect(client.invalid).toEqual([]);
  });

  it('finds mate in one (side-to-move score)', async () => {
    // Back-rank mate: Ra8#.
    client.send({
      type: 'analyze',
      sessionId: 'sf',
      searchId: 2,
      engine: 'stockfish',
      fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
      depth: 10,
    });
    const end = await client.terminal('sf', 2, 30_000);
    expect(end).toMatchObject({ type: 'bestmove', bestMove: { move: 'a1a8' } });
    const last = client.messages
      .filter((m): m is InfoMessage => m.type === 'info' && m.searchId === 2)
      .at(-1);
    expect(last?.info.score).toEqual({ mate: 1 });
  });
});
