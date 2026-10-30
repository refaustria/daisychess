import {
  EloCalibrationSchema,
  MAIA_ELO_LEVELS,
  MAIA_ELO_VERSION,
  reviewGameKey,
  type EloCalibration,
} from '@daisychess/engine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureReviewCache,
  getStoredReview,
  putStoredReview,
  REVIEW_CACHE_VERSION,
  type StoredReview,
} from '../review/reviewCache';
import { useGameStore } from '../store/gameStore';
import {
  ELO_CALIBRATION,
  eloFromHints,
  eloShortText,
  eloView,
  fallbackEloText,
  fallbackEstimate,
  maiaEloBand,
  maiaEloShort,
  requestEloEstimate,
  resetEloEstimate,
  useEloStore,
  type EloHints,
  type EloRequest,
} from './eloEstimate';
import { eloTestGame, newServerAnswer, oldServerAnswer, type EloTestGame } from './eloTestUtils';
import { configureHintCache, getStoredHints, hintId } from './hintCache';
import { setMaiaHintClientFactory } from './hintClient';
import { resetMaiaHints } from './hintStore';
import type { MaiaHint } from './hints';
import { coded, fakeMaiaServer, instantSleep } from './hintTestUtils';

let game: EloTestGame;
let key: string;

function request(over: Partial<EloRequest> = {}): EloRequest {
  const g = useGameStore.getState();
  return {
    startFen: g.startFen,
    moves: g.moves,
    summary: game.summary,
    details: game.details,
    lastBookPly: 0,
    enabled: true,
    reviewEngine: 'auto',
    ...over,
  };
}

function install(answer: Parameters<typeof fakeMaiaServer>[0]) {
  const server = fakeMaiaServer(answer);
  setMaiaHintClientFactory(server.createClient, { sleep: instantSleep(), minIntervalMs: 0 });
  return server;
}

const ratingOf = (q: string) => Number(q.split(':')[0]);

async function storeRecord(): Promise<void> {
  const g = useGameStore.getState();
  const record: StoredReview = {
    gameKey: key,
    startFen: g.startFen,
    moves: g.moves.map((m) => m.san),
    preset: 'fast',
    options: { movetime: 300 },
    summary: game.summary,
    moveDetails: {},
    engine: { kind: 'browser' },
    createdAt: 1,
    version: REVIEW_CACHE_VERSION,
  };
  await putStoredReview(record);
}

beforeEach(async () => {
  // Memory backend (fast); hintCache.test covers IndexedDB. It survives resetEloEstimate().
  configureHintCache(null);
  configureReviewCache(null);
  game = eloTestGame(80);
  useGameStore.getState().loadPgn(game.pgn);
  const g = useGameStore.getState();
  key = reviewGameKey(
    g.startFen,
    g.moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`),
  );
  resetMaiaHints();
  resetEloEstimate();
  await storeRecord();
});
afterEach(() => {
  setMaiaHintClientFactory(null);
  resetMaiaHints();
  resetEloEstimate();
  configureHintCache(undefined);
  configureReviewCache(undefined);
});

describe('requestEloEstimate: Maia run', () => {
  it('level-major jobs, ≤ 30 plies per side, played+best requested; estimates written once', async () => {
    const server = install(newServerAnswer(game));
    const progress: number[] = [];
    const unsub = useEloStore.subscribe((s) => progress.push(s.progress.done));
    await requestEloEstimate(request());
    unsub();

    // 40 moves per side → 30 scored positions each, × 9 levels.
    expect(server.queries).toHaveLength(2 * 30 * 9);
    const ratings = server.queries.map(ratingOf);
    expect(ratings).toEqual([...ratings].sort((a, b) => a - b));
    expect(server.created).toEqual(MAIA_ELO_LEVELS.map((l) => `maia-${l}`));
    for (const level of MAIA_ELO_LEVELS)
      expect(ratings.filter((r) => r === level)).toHaveLength(60);
    expect(server.policyMoves.every((m) => m !== undefined && m.length >= 1)).toBe(true);

    const s = useEloStore.getState();
    expect(s.status).toBe('done');
    expect(s.progress).toEqual({ done: 18, total: 18 });
    expect(Math.max(...progress)).toBe(18);
    for (const side of ['white', 'black'] as const) {
      const e = s.estimates[side]!;
      expect(e).toMatchObject({ method: 'maia', exact: true, positions: 30 });
      expect(e.maiaVersion).toBe(MAIA_ELO_VERSION);
      expect(Math.abs(e.rating - 1500)).toBeLessThanOrEqual(100);
      expect(e.low!).toBeLessThanOrEqual(1500);
      expect(e.high!).toBeGreaterThanOrEqual(1500);
    }

    // The record now carries the estimate…
    const record = await getStoredReview(key);
    expect(record?.elo?.white).toEqual(s.estimates.white);
    expect(record?.elo?.black).toEqual(s.estimates.black);

    // …so a second request (new tab: nothing in memory) with the record's estimate queries nothing.
    resetEloEstimate();
    const again = install(newServerAnswer(game));
    await requestEloEstimate(request({ storedElo: record!.elo! }));
    expect(again.queries).toHaveLength(0);
    expect(again.created).toHaveLength(0);
    expect(useEloStore.getState()).toMatchObject({ status: 'done', estimates: record!.elo });
  });

  it('without the record estimate, the cached answers still make a rerun free', async () => {
    install(newServerAnswer(game));
    await requestEloEstimate(request());
    resetEloEstimate(); // forgets the in-memory hints; the IndexedDB cache stays
    const again = install(newServerAnswer(game));
    await requestEloEstimate(request());
    expect(again.queries).toHaveLength(0);
    expect(useEloStore.getState().estimates.white).toBeDefined();
    const stored = await getStoredHints([hintId(key, 1, 1100), hintId(key, 2, 1900)]);
    expect(stored).toHaveLength(2);
  });

  it('a server that ignores policyMoves gives exact: false and a band of at least ±200', async () => {
    install(oldServerAnswer(game, 5));
    await requestEloEstimate(request());
    const s = useEloStore.getState();
    for (const side of ['white', 'black'] as const) {
      const e = s.estimates[side]!;
      expect(e.exact).toBe(false);
      if (e.low !== undefined) expect(e.rating - e.low).toBeGreaterThanOrEqual(200 - 50);
      if (e.high !== undefined) expect(e.high - e.rating).toBeGreaterThanOrEqual(200 - 50);
      expect((e.high ?? 1900) - (e.low ?? 1100)).toBeGreaterThanOrEqual(400 - 100);
    }
  });

  it('busy mid-run: finished queries are cached and the next request resumes with the rest', async () => {
    const busyAt = (rating: number, fen: string, attempt: number, pm?: readonly string[]) =>
      rating >= 1500 ? coded('no_capacity') : newServerAnswer(game)(rating, fen, attempt, pm);
    install(busyAt);
    await requestEloEstimate(request());
    let s = useEloStore.getState();
    expect(s.status).toBe('busy');
    expect(s.estimates).toEqual({});
    // Levels 1100–1400 of both sides are complete.
    expect(s.progress).toEqual({ done: 8, total: 18 });
    // Fallback still there.
    expect(s.fallback.white).toBeDefined();
    expect((await getStoredReview(key))?.elo).toBeUndefined();

    // Cooldown: an immediate retry asks nobody.
    const cooling = install(newServerAnswer(game));
    resetEloEstimate();
    await requestEloEstimate(request());
    expect(cooling.queries).toHaveLength(0);
    expect(useEloStore.getState().status).toBe('busy');

    // After the cooldown (reset) only the missing levels are queried.
    resetMaiaHints();
    resetEloEstimate();
    const resumed = install(newServerAnswer(game));
    await requestEloEstimate(request());
    expect(resumed.queries).toHaveLength(5 * 60);
    expect(resumed.queries.every((q) => ratingOf(q) >= 1500)).toBe(true);
    s = useEloStore.getState();
    expect(s.status).toBe('done');
    expect(s.estimates.white?.exact).toBe(true);
    expect((await getStoredReview(key))?.elo?.black).toEqual(s.estimates.black);
  });

  it('aborts when another game is put on the board; the answers so far are kept', async () => {
    let n = 0;
    const answer = (rating: number, fen: string, attempt: number, pm?: readonly string[]) => {
      if (++n === 25) useGameStore.getState().loadPgn('1. d4 d5 2. c4 e6');
      return newServerAnswer(game)(rating, fen, attempt, pm);
    };
    const server = install(answer);
    await requestEloEstimate(request());
    expect(server.queries.length).toBeLessThan(30);
    expect(server.disposed).toEqual(server.created);
    expect(useEloStore.getState().estimates).toEqual({});
    expect(await getStoredHints([hintId(key, 1, 1100)])).toHaveLength(1);
  });

  it('the same game reloaded keeps the run; a repeated request is idempotent', async () => {
    install(newServerAnswer(game));
    const p1 = requestEloEstimate(request());
    const p2 = requestEloEstimate(request());
    expect(p2).toBe(p1);
    await p1;
    expect(useEloStore.getState().status).toBe('done');
  });
});

describe('requestEloEstimate: skipped runs and visibility', () => {
  it('maiaHints off / browser review setting: fallback only, nothing queried', async () => {
    const server = install(newServerAnswer(game));
    await requestEloEstimate(request({ enabled: false }));
    expect(useEloStore.getState()).toMatchObject({ status: 'off', estimates: {} });
    expect(useEloStore.getState().fallback.white).toBeDefined();
    await requestEloEstimate(request({ reviewEngine: 'browser' }));
    expect(useEloStore.getState().status).toBe('off');
    expect(server.queries).toHaveLength(0);
  });

  it('no server: unavailable, fallback shown', async () => {
    setMaiaHintClientFactory(null);
    await requestEloEstimate(request());
    const s = useEloStore.getState();
    expect(s.status).toBe('unavailable');
    expect(eloView(s, 'white')?.fallback).toBeDefined();
  });

  it('a record with both estimates: shown at once, no run', async () => {
    const server = install(newServerAnswer(game));
    const elo = {
      white: {
        method: 'maia',
        rating: 1540,
        low: 1400,
        high: 1700,
        positions: 30,
        exact: true,
        maiaVersion: 1,
      },
      black: {
        method: 'maia',
        rating: 1300,
        low: 1200,
        high: 1400,
        positions: 30,
        exact: true,
        maiaVersion: 1,
      },
    } as const;
    await requestEloEstimate(request({ storedElo: elo }));
    expect(server.queries).toHaveLength(0);
    const s = useEloStore.getState();
    expect(s.status).toBe('done');
    expect(eloView(s, 'white')?.maia?.rating).toBe(1540);
    expect(eloShortText(eloView(s, 'black'))).toBe('~1300');
  });

  it('a stored estimate of another method version is recomputed', async () => {
    const server = install(newServerAnswer(game));
    const old = {
      method: 'maia',
      rating: 1540,
      positions: 30,
      exact: true,
      maiaVersion: 99,
    } as const;
    await requestEloEstimate(request({ storedElo: { white: old, black: old } }));
    expect(server.queries).toHaveLength(540);
  });

  it("the engine's side gets nothing: no queries, no fallback, no view", async () => {
    const server = install(newServerAnswer(game));
    await requestEloEstimate(request({ engineSide: 'black' }));
    expect(server.queries).toHaveLength(30 * 9);
    const s = useEloStore.getState();
    expect(s.estimates.black).toBeUndefined();
    expect(s.fallback.black).toBeUndefined();
    expect(eloView(s, 'black')).toBeUndefined();
    expect(eloView(s, 'white')?.maia).toBeDefined();
    expect((await getStoredReview(key))?.elo).toEqual({ white: s.estimates.white });
  });

  it('fewer than 10 scored positions: nothing at all', async () => {
    game = eloTestGame(18);
    useGameStore.getState().loadPgn(game.pgn);
    const server = install(newServerAnswer(game));
    await requestEloEstimate(request());
    const s = useEloStore.getState();
    expect(server.queries).toHaveLength(0);
    expect(eloView(s, 'white')).toBeUndefined();
    expect(eloView(s, 'black')).toBeUndefined();
  });

  it('book moves are not scored (lastBookPly)', async () => {
    const server = install(newServerAnswer(game));
    // 80 plies, book until ply 40: 20 moves per side remain.
    await requestEloEstimate(request({ lastBookPly: 40 }));
    expect(server.queries).toHaveLength(2 * 20 * 9);
    expect(useEloStore.getState().estimates.white?.positions).toBe(20);
  });

  it('while running: the fallback with the progress; the Maia estimate replaces it at the end', async () => {
    let seen: ReturnType<typeof eloView>;
    let n = 0;
    const answer = (rating: number, fen: string, attempt: number, pm?: readonly string[]) => {
      if (++n === 70) seen = eloView(useEloStore.getState(), 'white');
      return newServerAnswer(game)(rating, fen, attempt, pm);
    };
    install(answer);
    const p = requestEloEstimate(request());
    // At once, before any query: the fallback, pending.
    const first = eloView(useEloStore.getState(), 'white');
    expect(first?.fallback).toBeDefined();
    expect(first?.pending).toEqual({ done: 0, total: 18 });
    await p;
    expect(seen!.fallback).toBeDefined();
    expect(seen!.pending?.done).toBe(2); // level 1100 of both sides done after 60 queries
    const last = eloView(useEloStore.getState(), 'white');
    expect(last?.maia).toBeDefined();
    expect(last?.fallback).toBeUndefined();
  });
});

describe('eloFromHints', () => {
  const hint = (
    ply: number,
    rating: number,
    playedP: number | undefined,
    minP?: number,
  ): MaiaHint => ({
    ply,
    rating,
    top: [],
    ...(playedP !== undefined ? { playedP } : {}),
    playedExact: playedP !== undefined,
    playedIsTop: false,
    ...(minP !== undefined ? { minP } : {}),
    entries: 5,
  });

  it('reproduces the engine-core vector (parabola: two equal neighbours → halfway)', () => {
    // engine-core elo.test.ts: 10 samples, 25 legal moves → estimate 1550, band 1500–1600.
    const p = (l: number) => ({ 1300: 0.1, 1400: 0.2, 1500: 0.4, 1600: 0.4, 1700: 0.2 })[l] ?? 0.05;
    const hints: Record<number, Record<number, MaiaHint>> = {};
    const plies = Array.from({ length: 10 }, (_, i) => 21 + 2 * i);
    const legal: Record<number, number> = {};
    for (const ply of plies) {
      hints[ply] = {};
      legal[ply] = 25;
      for (const l of MAIA_ELO_LEVELS) hints[ply]![l] = hint(ply, l, p(l));
    }
    expect(eloFromHints(hints, plies, legal)).toEqual({
      method: 'maia',
      rating: 1550,
      low: 1500,
      high: 1600,
      positions: 10,
      exact: true,
      maiaVersion: MAIA_ELO_VERSION,
    });
  });

  it('missing probabilities use the floor and make it inexact; a flat result is undefined', () => {
    const hints: EloHints = {};
    expect(eloFromHints(hints, [], {})).toBeUndefined();
    const flat: Record<number, Record<number, MaiaHint>> = {};
    const plies = Array.from({ length: 12 }, (_, i) => i + 1);
    for (const ply of plies) {
      flat[ply] = {};
      for (const l of MAIA_ELO_LEVELS) flat[ply]![l] = hint(ply, l, undefined, 0.03);
    }
    expect(eloFromHints(flat, plies, {})).toBeUndefined();
  });

  it('edges: <1100 and >1900', () => {
    const plies = Array.from({ length: 12 }, (_, i) => i + 1);
    const build = (f: (l: number) => number) => {
      const h: Record<number, Record<number, MaiaHint>> = {};
      for (const ply of plies) {
        h[ply] = {};
        for (const l of MAIA_ELO_LEVELS) h[ply]![l] = hint(ply, l, f(l));
      }
      return h;
    };
    const low = eloFromHints(
      build((l) => (2000 - l) / 1000),
      plies,
      {},
    )!;
    expect(low.edge).toBe('low');
    expect(maiaEloShort(low)).toBe('<1100');
    const high = eloFromHints(
      build((l) => (l - 1000) / 1000),
      plies,
      {},
    )!;
    expect(maiaEloShort(high)).toBe('>1900');
    expect(maiaEloBand(high)).toBeUndefined();
  });
});

describe('fallbackEstimate', () => {
  const table: EloCalibration = {
    version: 1,
    source: { month: '2026-09', games: 1000 },
    speeds: {
      blitz: {
        knots: [
          [2, 2000],
          [10, 1000],
        ],
        residualSd: 240,
      },
      unknown: {
        knots: [
          [2, 1800],
          [10, 1000],
        ],
        residualSd: 310,
      },
    },
  };

  it('the committed table is valid (provisional until M31-8/M31-10 ship the calibrated one)', () => {
    expect(EloCalibrationSchema.safeParse(ELO_CALIBRATION).success).toBe(true);
    const f = fallbackEstimate(game.summary, 'white', 0)!;
    expect(f.provisional).toBe(ELO_CALIBRATION.source.month === 'provisional');
  });

  it('mean loss over the scored positions through the speed class curve', () => {
    // Every move loses 6 → blitz (180+2): 2000 − 1000·(6−2)/8 = 1500, sd 250.
    const blitz = fallbackEstimate(eloTestGame(80, 6).summary, 'white', 0, '180+2', table)!;
    expect(blitz).toMatchObject({
      method: 'fallback',
      rating: 1500,
      sd: 250,
      positions: 30,
      speed: 'blitz',
      provisional: false,
    });
    expect(fallbackEloText(blitz)).toBe('≈ 1500 ± 250');
    const unknown = fallbackEstimate(eloTestGame(80, 6).summary, 'black', 0, undefined, table)!;
    expect(unknown).toMatchObject({ rating: 1400, sd: 300, speed: 'unknown' });
  });

  it('book moves are left out and < 10 positions give nothing', () => {
    expect(fallbackEstimate(game.summary, 'white', 62, '180+2', table)).toBeUndefined();
    expect(fallbackEstimate(eloTestGame(18).summary, 'white', 0)).toBeUndefined();
  });
});
