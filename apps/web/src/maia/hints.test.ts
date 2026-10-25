import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAIA_RATING,
  gameLevels,
  hintFromPolicy,
  hintJobs,
  MAIA_HIGHEST_NOTE,
  MAIA_LOWEST_NOTE,
  maiaEngineId,
  nearestMaiaLevel,
  normalizeMaiaRating,
  parseElo,
  runHintJobs,
  type HintJob,
  type HintSourceDetail,
  type MaiaHint,
} from './hints';
import { coded, fakeMaiaServer, instantSleep } from './hintTestUtils';

/** Position before 3... Nf6?? of 1. e4 e5 2. Bc4 Nc6 3. Qh5 (best: g6). */
const SCHOLAR_BEFORE = (() => {
  const c = new Chess();
  for (const m of ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5']) c.move(m);
  return c.fen();
})();
const POLICY = [
  { uci: 'g8f6', p: 0.38 },
  { uci: 'g7g6', p: 0.3 },
  { uci: 'd8e7', p: 0.15 },
  { uci: 'd8f6', p: 0.1 },
  { uci: 'g8h6', p: 0.02 },
];
const JOB: HintJob = {
  ply: 6,
  rating: 1500,
  fenBefore: SCHOLAR_BEFORE,
  playedUci: 'g8f6',
  bestUci: 'g7g6',
};

describe('rating mapping', () => {
  it('rounds to the nearest Maia level and clamps with a note', () => {
    expect(nearestMaiaLevel(1523)).toEqual({ rating: 1500 });
    expect(nearestMaiaLevel(1550)).toEqual({ rating: 1600 });
    expect(nearestMaiaLevel(1549)).toEqual({ rating: 1500 });
    expect(nearestMaiaLevel(1100)).toEqual({ rating: 1100 });
    expect(nearestMaiaLevel(1900)).toEqual({ rating: 1900 });
    expect(nearestMaiaLevel(1901)).toEqual({ rating: 1900, note: MAIA_HIGHEST_NOTE });
    expect(nearestMaiaLevel(2650)).toEqual({ rating: 1900, note: "Maia's highest level" });
    expect(nearestMaiaLevel(800)).toEqual({ rating: 1100, note: MAIA_LOWEST_NOTE });
  });

  it('parses PGN rating headers', () => {
    expect(parseElo('1523')).toBe(1523);
    expect(parseElo('1523?')).toBe(1523);
    expect(parseElo(' 2100 ')).toBe(2100);
    expect(parseElo('?')).toBeUndefined();
    expect(parseElo('-')).toBeUndefined();
    expect(parseElo('')).toBeUndefined();
    expect(parseElo(undefined)).toBeUndefined();
    expect(parseElo('99999')).toBeUndefined();
  });

  it('levels per side from WhiteElo/BlackElo, the setting for a side without a rating', () => {
    expect(gameLevels({ WhiteElo: '1523', BlackElo: '2210' }, 1300)).toEqual({
      white: { rating: 1500, source: 'pgn', elo: 1523 },
      black: { rating: 1900, source: 'pgn', elo: 2210, note: MAIA_HIGHEST_NOTE },
    });
    expect(gameLevels({ WhiteElo: '?', BlackElo: '1650' }, 1300)).toEqual({
      white: { rating: 1300, source: 'setting' },
      black: { rating: 1700, source: 'pgn', elo: 1650 },
    });
    expect(gameLevels({}, 1700)).toEqual({
      white: { rating: 1700, source: 'setting' },
      black: { rating: 1700, source: 'setting' },
    });
    // An invalid setting falls back to the default level.
    expect(gameLevels({}, 1234).white.rating).toBe(DEFAULT_MAIA_RATING);
  });

  it('normalizes the level setting and names the engine', () => {
    expect(normalizeMaiaRating(1800)).toBe(1800);
    expect(normalizeMaiaRating(1850)).toBe(1500);
    expect(normalizeMaiaRating('1800')).toBe(1500);
    expect(maiaEngineId(1500)).toBe('maia-1500');
  });
});

describe('hintFromPolicy', () => {
  it('top 3 in SAN, probabilities of the played and the best move', () => {
    expect(hintFromPolicy(JOB, POLICY)).toEqual<MaiaHint>({
      ply: 6,
      rating: 1500,
      top: [
        { uci: 'g8f6', san: 'Nf6', p: 0.38 },
        { uci: 'g7g6', san: 'g6', p: 0.3 },
        { uci: 'd8e7', san: 'Qe7', p: 0.15 },
      ],
      playedP: 0.38,
      bestP: 0.3,
      playedIsTop: true,
      minP: 0.02,
      entries: 5,
    });
  });

  it('a played/best move outside the top 5 has no probability', () => {
    const h = hintFromPolicy({ ...JOB, playedUci: 'a7a6', bestUci: 'h7h6' }, POLICY)!;
    expect(h.playedP).toBeUndefined();
    expect(h.bestP).toBeUndefined();
    expect(h.playedIsTop).toBe(false);
  });

  it('sorts unsorted policies, drops illegal entries, maps king-takes-rook castling', () => {
    const c = new Chess();
    for (const m of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']) c.move(m);
    const h = hintFromPolicy(
      { ply: 7, rating: 1200, fenBefore: c.fen(), playedUci: 'e1g1', bestUci: 'c2c3' },
      [
        { uci: 'c2c3', p: 0.2 },
        { uci: 'e1h1', p: 0.5 },
        { uci: 'a1a8', p: 0.25 }, // illegal
      ],
    )!;
    expect(h.top.map((m) => m.san)).toEqual(['O-O', 'c3']);
    expect(h.playedIsTop).toBe(true);
    expect(h.playedP).toBe(0.5);
    expect(h.bestP).toBe(0.2);
    expect(h.minP).toBeUndefined();
  });

  it('nothing usable: undefined', () => {
    expect(hintFromPolicy(JOB, [])).toBeUndefined();
    expect(hintFromPolicy(JOB, [{ uci: 'a1a8', p: 1 }])).toBeUndefined();
    expect(hintFromPolicy({ ...JOB, fenBefore: 'not a fen' }, POLICY)).toBeUndefined();
  });
});

describe('hintJobs', () => {
  const d = (
    ply: number,
    classification: HintSourceDetail['classification'],
    mover: 'white' | 'black',
  ): HintSourceDetail => ({
    ply,
    classification,
    mover,
    fenBefore: `fen${ply}`,
    playedUci: 'e2e4',
    ...(ply % 2 ? { bestUci: 'd2d4' } : {}),
  });

  it('only inaccuracies, mistakes and blunders, at the mover level, in ply order', () => {
    const details = {
      4: d(4, 'blunder', 'black'),
      1: d(1, 'best', 'white'),
      2: d(2, 'good', 'black'),
      3: d(3, 'mistake', 'white'),
      5: d(5, 'inaccuracy', 'white'),
      6: d(6, 'forced', 'black'),
      7: d(7, 'excellent', 'white'),
    };
    const jobs = hintJobs(details, gameLevels({ WhiteElo: '1400', BlackElo: '1800' }, 1500));
    expect(jobs).toEqual([
      { ply: 3, rating: 1400, fenBefore: 'fen3', playedUci: 'e2e4', bestUci: 'd2d4' },
      { ply: 4, rating: 1800, fenBefore: 'fen4', playedUci: 'e2e4' },
      { ply: 5, rating: 1400, fenBefore: 'fen5', playedUci: 'e2e4', bestUci: 'd2d4' },
    ]);
  });
});

describe('runHintJobs', () => {
  const jobsAt = (ratings: number[]): HintJob[] =>
    ratings.map((rating, i) => ({ ...JOB, ply: 6 + i * 2, rating }));

  it('one client per rating, groups one after another, every client disposed', async () => {
    const server = fakeMaiaServer(() => POLICY);
    const hints: MaiaHint[] = [];
    const status = await runHintJobs(jobsAt([1500, 1900, 1500, 1900]), {
      createClient: server.createClient,
      onHint: (h) => hints.push(h),
      sleep: instantSleep(),
    });
    expect(status).toBe('done');
    expect(server.created).toEqual(['maia-1500', 'maia-1900']);
    expect(server.disposed).toEqual(['maia-1500', 'maia-1900']);
    expect(server.maxAlive).toBe(1);
    expect(server.queries).toHaveLength(4);
    expect(hints.map((h) => [h.ply, h.rating])).toEqual([
      [6, 1500],
      [10, 1500],
      [8, 1900],
      [12, 1900],
    ]);
  });

  it('throttles the queries of one client', async () => {
    const server = fakeMaiaServer(() => POLICY);
    const slept: number[] = [];
    let t = 0;
    await runHintJobs(jobsAt([1500, 1500, 1500]), {
      createClient: server.createClient,
      onHint: () => undefined,
      minIntervalMs: 60,
      now: () => t,
      sleep: (ms) => {
        slept.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });
    expect(slept).toEqual([60, 60]);
  });

  it('no_capacity: retried with backoff, then the hint arrives', async () => {
    const server = fakeMaiaServer((_r, _f, attempt) =>
      attempt < 2
        ? coded('no_capacity', 'all 3 process(es) of engine group "maia" are busy')
        : POLICY,
    );
    const slept: number[] = [];
    const hints: MaiaHint[] = [];
    const status = await runHintJobs([JOB], {
      createClient: server.createClient,
      onHint: (h) => hints.push(h),
      retryDelaysMs: [100, 200, 400],
      minIntervalMs: 0,
      sleep: instantSleep(slept),
    });
    expect(status).toBe('done');
    expect(slept).toEqual([100, 200]);
    expect(server.queries).toHaveLength(3);
    expect(hints).toHaveLength(1);
  });

  it('no_capacity through every retry: busy, partial results kept', async () => {
    // First position answers, the second is always busy.
    const second = { ...JOB, ply: 8, fenBefore: new Chess().fen(), playedUci: 'e2e4' };
    const busy = fakeMaiaServer((_r, fen) =>
      fen === second.fenBefore ? coded('no_capacity') : POLICY,
    );
    const hints: MaiaHint[] = [];
    const status = await runHintJobs([JOB, second], {
      createClient: busy.createClient,
      onHint: (h) => hints.push(h),
      retryDelaysMs: [1, 2],
      minIntervalMs: 0,
      sleep: instantSleep(),
    });
    expect(status).toBe('busy');
    expect(hints.map((h) => h.ply)).toEqual([6]);
    expect(busy.queries).toHaveLength(4); // 1 + (1 + 2 retries)
    expect(busy.disposed).toEqual(['maia-1500']);
  });

  it('refused token: unauthorized, no query', async () => {
    const server = fakeMaiaServer(() => POLICY, { load: () => coded('unauthorized') });
    const status = await runHintJobs([JOB], {
      createClient: server.createClient,
      onHint: () => undefined,
    });
    expect(status).toBe('unauthorized');
    expect(server.queries).toEqual([]);
    expect(server.disposed).toEqual(['maia-1500']);
  });

  it('no Maia on the server (unknown engine, or not a human engine): unavailable', async () => {
    const missing = fakeMaiaServer(() => POLICY, { load: () => coded('unknown_engine') });
    expect(
      await runHintJobs([JOB], { createClient: missing.createClient, onHint: () => undefined }),
    ).toBe('unavailable');
    const notHuman = fakeMaiaServer(() => POLICY, {
      engines: (id) => [
        { id, name: 'X', enabled: true, defaults: { threads: 1, hash: 16 }, style: 'strength' },
      ],
    });
    expect(
      await runHintJobs([JOB], { createClient: notHuman.createClient, onHint: () => undefined }),
    ).toBe('unavailable');
    expect(missing.queries).toEqual([]);
    expect(notHuman.queries).toEqual([]);
  });

  it('node lost mid-run (1012): one fresh session finishes the remaining jobs', async () => {
    let n = 0;
    const server = fakeMaiaServer(() => (n++ === 1 ? coded('node_lost', 'node lost') : POLICY));
    const hints: MaiaHint[] = [];
    const status = await runHintJobs(jobsAt([1500, 1500, 1500]), {
      createClient: server.createClient,
      onHint: (h) => hints.push(h),
      minIntervalMs: 0,
    });
    expect(status).toBe('done');
    expect(hints).toHaveLength(3);
  });

  it('connection lost mid-run: unavailable with the hints so far', async () => {
    let n = 0;
    const server = fakeMaiaServer(() => (n++ === 1 ? coded('closed', 'connection lost') : POLICY));
    const hints: MaiaHint[] = [];
    const status = await runHintJobs(jobsAt([1500, 1500, 1500]), {
      createClient: server.createClient,
      onHint: (h) => hints.push(h),
      minIntervalMs: 0,
    });
    expect(status).toBe('unavailable');
    expect(hints.map((h) => h.ply)).toEqual([6]);
    expect(server.queries).toHaveLength(2);
  });

  it('a query without an answer times out', async () => {
    const server = fakeMaiaServer(() => POLICY);
    const hanging = async (id: string) => {
      const c = await server.createClient(id);
      return {
        ...c,
        engines: undefined,
        load: () => Promise.resolve(),
        dispose: () => c.dispose(),
        analyze: () => ({
          [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }),
        }),
      };
    };
    const status = await runHintJobs([JOB], {
      createClient: hanging,
      onHint: () => undefined,
      timeoutMs: 20,
    });
    expect(status).toBe('unavailable');
    expect(server.disposed).toEqual(['maia-1500']);
  });

  it('a rejected position is skipped; a position without policy gives no hint', async () => {
    const other = { ...JOB, ply: 8, fenBefore: new Chess().fen(), playedUci: 'e2e4' };
    const server = fakeMaiaServer((_r, fen) =>
      fen === SCHOLAR_BEFORE ? coded('invalid_request') : undefined,
    );
    const hints: MaiaHint[] = [];
    const status = await runHintJobs([JOB, other], {
      createClient: server.createClient,
      onHint: (h) => hints.push(h),
      minIntervalMs: 0,
    });
    expect(status).toBe('done');
    expect(hints).toEqual([]);
    expect(server.queries).toHaveLength(2);
  });

  it('abort: stops before the next query and releases the client', async () => {
    const ctrl = new AbortController();
    const server = fakeMaiaServer(() => POLICY);
    const hints: MaiaHint[] = [];
    const status = await runHintJobs(jobsAt([1500, 1500, 1500]), {
      createClient: server.createClient,
      onHint: (h) => {
        hints.push(h);
        ctrl.abort();
      },
      signal: ctrl.signal,
      minIntervalMs: 0,
    });
    expect(status).toBe('aborted');
    expect(hints).toHaveLength(1);
    expect(server.queries).toHaveLength(1);
    expect(server.disposed).toEqual(['maia-1500']);
  });
});
