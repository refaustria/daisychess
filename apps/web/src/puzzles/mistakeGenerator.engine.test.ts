import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { Chess } from 'chess.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyzeOptions, Engine } from '@daisychess/engine-core';
import { UciSession } from '../engine/UciSession';
import type { MoveDetail, MoveDetails } from '../review/details';
import type { StoredReview } from '../review/reviewCache';
import type { LedgerGame } from './gameLedger';
import { DEFAULT_GENERATOR_HOOKS, generateMistakePuzzles } from './mistakeGenerator';
import { configureMistakeStore, listMistakes } from './mistakeStore';

/**
 * Opt-in slow test (M30-10): the generator against the real native Stockfish of
 * `pnpm fetch-engines` (the browser WASM build does not run in Node). Runs only with
 * `DAISYCHESS_SLOW_TESTS=1` and the binary present:
 *   DAISYCHESS_SLOW_TESTS=1 pnpm --filter @daisychess/web exec vitest run mistakeGenerator.engine
 * One thread, 16 MB hash, the generator's own search budgets (≤ 4 searches of ≤ 1 s).
 */
/** The repo's `engines/stockfish/stockfish`, looked up from the working directory upwards. */
async function findStockfish(): Promise<string | undefined> {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const path = join(dir, 'engines', 'stockfish', 'stockfish');
    const ok = await access(path, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (ok) return path;
    dir = dirname(dir);
  }
  return undefined;
}

const STOCKFISH = process.env.DAISYCHESS_SLOW_TESTS === '1' ? await findStockfish() : undefined;

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** 4. d3?? misses 4. Qxf7#. */
const SANS = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'd3'];

function fixtureReview(): StoredReview {
  const chess = new Chess(START);
  const details: MoveDetails = {};
  SANS.forEach((san, i) => {
    const fenBefore = chess.fen();
    const m = chess.move(san);
    const blunder = i === 6;
    details[i + 1] = {
      ply: i + 1,
      mover: i % 2 === 0 ? 'white' : 'black',
      moveLabel: '',
      playedUci: `${m.from}${m.to}`,
      playedSan: san,
      bestUci: blunder ? 'h5f7' : `${m.from}${m.to}`,
      bestLine: [],
      bestLineSan: '',
      bestLineMoves: [],
      bestLineFen: fenBefore,
      fenBefore,
      fenAfter: chess.fen(),
      evalBeforeWhite: blunder ? { mate: 1 } : { cp: 20 },
      evalAfterWhite: blunder ? { cp: 30 } : { cp: 20 },
      ...(blunder ? { evalIfBest: { mate: 1 } } : {}),
      swing: '',
      winProbLoss: blunder ? 70 : 0,
      playedIsBest: !blunder,
      classification: blunder ? 'blunder' : 'good',
    } as MoveDetail;
  });
  return {
    gameKey: 'fixture',
    startFen: START,
    moves: SANS,
    preset: 'fast',
    options: { movetime: 300 },
    summary: {} as StoredReview['summary'],
    moveDetails: details,
    engine: { kind: 'browser' },
    createdAt: 1,
    version: 1,
  };
}

describe.skipIf(STOCKFISH === undefined)(
  'mistake generator with the real Stockfish (slow, opt-in)',
  () => {
    let proc: ChildProcessWithoutNullStreams;
    let session: UciSession;
    let engine: Engine;
    const searches: AnalyzeOptions[] = [];

    beforeAll(async () => {
      proc = spawn(STOCKFISH!, [], { stdio: 'pipe' });
      const rl = createInterface({ input: proc.stdout });
      let receiver: (line: string) => void = () => undefined;
      rl.on('line', (l) => receiver(l));
      session = new UciSession({
        send: (line) => proc.stdin.write(`${line}\n`),
        onLine: (cb) => (receiver = cb),
      });
      await session.handshake();
      await session.setOptions({ Threads: 1, Hash: 16 });
      engine = {
        load: async () => undefined,
        setOptions: (o) => session.setOptions(o),
        analyze: (fen, opts) => {
          searches.push(opts);
          return session.analyze(fen, opts);
        },
        stop: () => session.stop(),
        dispose: async () => undefined,
      };
      configureMistakeStore(null);
    });

    afterAll(() => {
      session?.close();
      proc?.kill();
      configureMistakeStore(undefined);
    });

    it('finds the missed mate and stores it as a due puzzle', async () => {
      const game: LedgerGame = {
        gameKey: 'fixture',
        startFen: START,
        moves: SANS,
        headers: {},
        source: 'pgn',
        userSide: 'white',
        reviewedAt: 1,
      };
      const review = fixtureReview();
      const result = await generateMistakePuzzles(
        {},
        {
          ...DEFAULT_GENERATOR_HOOKS,
          openEngine: async () => ({
            engine,
            runsOn: { kind: 'browser' },
            dispose: async () => undefined,
          }),
          listGames: async () => [game],
          localReview: async () => review,
          serverReview: async () => undefined,
          pauseAnalysis: () => () => undefined,
          pauseSource: () => ({ reason: () => undefined, subscribe: () => () => undefined }),
        },
      );
      expect(result.status).toBe('done');
      expect(result.searches).toBeLessThanOrEqual(4);
      expect(searches[0]).toEqual({ movetime: 1000, multipv: 2 });
      const [p] = await listMistakes();
      expect(p?.puzzle.moves).toEqual(['g8f6', 'h5f7']);
    }, 30_000);
  },
);
