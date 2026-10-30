import { describe, expect, it } from 'vitest';
import {
  ELO_BAND_DELTA_LL,
  ELO_MAX_POSITIONS,
  ELO_MIN_POSITIONS,
  EloCalibrationSchema,
  EloEstimateSchema,
  MAIA_ELO_LEVELS,
  MAIA_ELO_VERSION,
  SPEED_CLASSES,
  eloLikelihood,
  fallbackElo,
  selectEloPlies,
  smoothPolicy,
  speedClass,
  type EloCalibration,
  type EloPlyCandidate,
  type EloSample,
  type MaiaEloLevel,
} from './index.js';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * A synthetic "Maia": per position a difficulty `t`; the best move's probability rises with the
 * level, an error and the rest share the remainder. The played moves follow `target`'s policy.
 */
function syntheticGame(target: number, positions: number, seed: number): EloSample[] {
  const rand = rng(seed);
  const samples: EloSample[] = [];
  for (let j = 0; j < positions; j++) {
    const t = 900 + rand() * 1200;
    const policy = (r: number) => {
      const best = 0.1 + 0.8 * sigmoid((r - t) / 150);
      return { best, error: (1 - best) * 0.7, other: (1 - best) * 0.3 };
    };
    const at = policy(target);
    const u = rand();
    const played: 'best' | 'error' | 'other' =
      u < at.best ? 'best' : u < at.best + at.error ? 'error' : 'other';
    const p: Partial<Record<MaiaEloLevel, number>> = {};
    for (const level of MAIA_ELO_LEVELS) p[level] = policy(level)[played];
    samples.push({ ply: 2 * j + 11, legalMoves: 30, p });
  }
  return samples;
}

/** One sample whose played move has probability `f(level)` at each level. */
function sample(
  f: (level: MaiaEloLevel) => number | undefined,
  extra: Partial<EloSample> = {},
): EloSample {
  const p: Partial<Record<MaiaEloLevel, number | undefined>> = {};
  for (const level of MAIA_ELO_LEVELS) p[level] = f(level);
  return { ply: 21, legalMoves: 25, p, ...extra };
}

describe('constants', () => {
  it('are the ADR-024 values', () => {
    expect(MAIA_ELO_LEVELS).toEqual([1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900]);
    expect(ELO_MAX_POSITIONS).toBe(30);
    expect(ELO_MIN_POSITIONS).toBe(10);
    expect(ELO_BAND_DELTA_LL).toBe(1.92);
    expect(MAIA_ELO_VERSION).toBe(1);
    expect(SPEED_CLASSES).toEqual(['bullet', 'blitz', 'rapid', 'classical', 'unknown']);
  });
});

describe('smoothPolicy', () => {
  it('mixes 2 % of the uniform distribution in', () => {
    expect(smoothPolicy(0.5, 20)).toBeCloseTo(0.98 * 0.5 + 0.02 / 20, 12);
    expect(smoothPolicy(0, 40)).toBeCloseTo(0.0005, 12);
    expect(smoothPolicy(1, 1)).toBeCloseTo(1, 12);
  });

  it('clamps p to 0…1 and legalMoves to ≥ 1; never returns 0', () => {
    expect(smoothPolicy(1.5, 10)).toBeCloseTo(smoothPolicy(1, 10), 12);
    expect(smoothPolicy(-1, 10)).toBeCloseTo(0.002, 12);
    expect(smoothPolicy(Number.NaN, 10)).toBeCloseTo(0.002, 12);
    expect(smoothPolicy(0, 0)).toBeCloseTo(0.02, 12);
    expect(smoothPolicy(0, Number.NaN)).toBeCloseTo(0.02, 12);
    expect(smoothPolicy(0, 218)).toBeGreaterThan(0);
  });
});

describe('eloLikelihood', () => {
  it.each([1300, 1500, 1700])(
    'recovers the level a synthetic game was played at (%i ± 100) with a band containing it',
    (target) => {
      const r = eloLikelihood(syntheticGame(target, 200, target));
      expect(r.exact).toBe(true);
      expect(r.edge).toBeUndefined();
      expect(r.estimate).toBeDefined();
      expect(Math.abs(r.estimate! - target)).toBeLessThanOrEqual(100);
      expect(r.low).toBeLessThanOrEqual(target);
      expect(r.high).toBeGreaterThanOrEqual(target);
      expect(r.ll).toHaveLength(9);
    },
  );

  it('a game of 30 positions still lands near its level with a wider band', () => {
    const r = eloLikelihood(syntheticGame(1500, 30, 7));
    expect(r.estimate).toBeDefined();
    expect(r.low! <= 1500 && r.high! >= 1500).toBe(true);
    expect(r.high! - r.low!).toBeGreaterThanOrEqual(100);
  });

  it('sums log p̃ per level', () => {
    const s = sample((l) => (l - 1000) / 1000);
    const r = eloLikelihood([s, s]);
    MAIA_ELO_LEVELS.forEach((l, k) => {
      expect(r.ll[k]).toBeCloseTo(2 * Math.log(smoothPolicy((l - 1000) / 1000, 25)), 10);
    });
  });

  it('refines the maximum with a parabola (two equal neighbours → halfway)', () => {
    const p = (l: number) => ({ 1300: 0.1, 1400: 0.2, 1500: 0.4, 1600: 0.4, 1700: 0.2 })[l] ?? 0.05;
    const r = eloLikelihood(Array.from({ length: 10 }, () => sample(p)));
    expect(r.estimate).toBe(1550);
    expect(r.low).toBe(1500);
    expect(r.high).toBe(1600);
    expect(r.edge).toBeUndefined();
  });

  it('the band holds the contiguous levels within 1.92 of the maximum', () => {
    // LL differences per sample are log(0.4/0.3) ≈ 0.288; 5 samples → 1.44 (inside), 7 → 2.01 (outside)
    const p = (l: number) => (l === 1500 ? 0.4 : l === 1400 || l === 1600 ? 0.3 : 0.01);
    const five = eloLikelihood(Array.from({ length: 5 }, () => sample(p)));
    expect([five.low, five.estimate, five.high]).toEqual([1400, 1500, 1600]);
    const seven = eloLikelihood(Array.from({ length: 7 }, () => sample(p)));
    expect([seven.low, seven.estimate, seven.high]).toEqual([1500, 1500, 1500]);
  });

  it('maps a maximum at the grid edges to edge low/high with an open band end', () => {
    const low = eloLikelihood(Array.from({ length: 12 }, () => sample((l) => (2000 - l) / 1000)));
    expect(low).toMatchObject({ estimate: 1100, edge: 'low', low: undefined, exact: true });
    expect(low.high).toBeGreaterThanOrEqual(1100);
    expect(low.high).toBeLessThan(1900);
    const high = eloLikelihood(Array.from({ length: 12 }, () => sample((l) => (l - 1000) / 1000)));
    expect(high).toMatchObject({ estimate: 1900, edge: 'high', high: undefined, exact: true });
    expect(high.low).toBeGreaterThan(1100);
  });

  it('a flat likelihood (or no samples) gives no estimate', () => {
    for (const r of [
      eloLikelihood([]),
      eloLikelihood(Array.from({ length: 20 }, () => sample(() => 0.3))),
      // a weak preference that stays inside 1.92 over the whole grid
      eloLikelihood([sample((l) => 0.3 + (l - 1100) / 10_000)]),
    ]) {
      expect(r.estimate).toBeUndefined();
      expect(r.low).toBeUndefined();
      expect(r.high).toBeUndefined();
      expect(r.edge).toBeUndefined();
    }
    expect(eloLikelihood([]).exact).toBe(true);
  });

  it('all-floor samples give exact: false (and, being flat, no estimate)', () => {
    const r = eloLikelihood(
      Array.from({ length: 15 }, () => sample(() => undefined, { minP: 0.04 })),
    );
    expect(r.exact).toBe(false);
    expect(r.estimate).toBeUndefined();
    // floor = min(minP, 0.02) / 2 = 0.01
    expect(r.ll[0]).toBeCloseTo(15 * Math.log(smoothPolicy(0.01, 25)), 10);
    const small = eloLikelihood([sample(() => undefined, { minP: 0.006 })]);
    expect(small.ll[0]).toBeCloseTo(Math.log(smoothPolicy(0.003, 25)), 10);
  });

  it('one floored sample makes the estimate inexact and widens the band to ±200', () => {
    const p = (l: number) => (l === 1500 ? 0.4 : l === 1400 || l === 1600 ? 0.1 : 0.01);
    const samples = Array.from({ length: 10 }, () => sample(p));
    const exact = eloLikelihood(samples);
    expect([exact.low, exact.estimate, exact.high, exact.exact]).toEqual([1500, 1500, 1500, true]);
    // missing only at 1100: the floor there barely moves the maximum
    const floored = sample((l) => (l === 1100 ? undefined : p(l)), { minP: 0.05 });
    const r = eloLikelihood([...samples, floored]);
    expect(r.exact).toBe(false);
    expect(r.estimate).toBe(1500);
    expect(r.low).toBe(1300);
    expect(r.high).toBe(1700);
  });

  it('the inexact widening stays inside the grid', () => {
    const p = (l: number) => (l === 1200 ? 0.5 : l === 1100 || l === 1300 ? 0.05 : 0.01);
    const r = eloLikelihood([
      ...Array.from({ length: 10 }, () => sample(p)),
      sample((l) => (l === 1900 ? undefined : p(l))),
    ]);
    expect(r.exact).toBe(false);
    expect(r.estimate).toBeGreaterThanOrEqual(1150);
    expect(r.low).toBe(1100);
    expect(r.high).toBeGreaterThanOrEqual(1400);
  });
});

describe('selectEloPlies', () => {
  const game = (n: number, over: (ply: number) => Partial<EloPlyCandidate> = () => ({})) =>
    Array.from({ length: n }, (_, k): EloPlyCandidate => {
      const ply = k + 1;
      return {
        ply,
        mover: ply % 2 === 1 ? 'white' : 'black',
        classification: 'good',
        winProbBefore: 50,
        ...over(ply),
      };
    });

  it("keeps the side's moves after the book that are not forced and undecided", () => {
    const moves = game(40, (ply) => {
      if (ply === 11) return { classification: 'forced' };
      if (ply === 13) return { legalMoves: 1 };
      if (ply === 15) return { winProbBefore: 95 };
      if (ply === 17) return { winProbBefore: 9.9 };
      if (ply === 19) return { winProbBefore: 10, legalMoves: 3 };
      if (ply === 21) return { winProbBefore: 90 };
      return {};
    });
    const plies = selectEloPlies(moves, 'white', 8).map((m) => m.ply);
    expect(plies).toEqual([9, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39]);
    // black: from ply 10 on
    expect(selectEloPlies(moves, 'black', 8).map((m) => m.ply)[0]).toBe(10);
    // custom start: nothing is book
    expect(selectEloPlies(moves, 'white', 0).map((m) => m.ply)[0]).toBe(1);
  });

  it('returns [] below the minimum of 10 positions', () => {
    const moves = game(30);
    expect(selectEloPlies(moves, 'white', 10)).toHaveLength(10); // plies 11…29
    expect(selectEloPlies(moves, 'white', 12)).toEqual([]); // 9 left
    expect(selectEloPlies(moves, 'white', 12, 30, 5)).toHaveLength(9);
  });

  it('decimates evenly to 30, deterministic, in ply order and starting with the first', () => {
    const moves = game(200).reverse(); // input order does not matter
    const sel = selectEloPlies(moves, 'white', 0);
    expect(sel).toHaveLength(30);
    const plies = sel.map((m) => m.ply);
    expect(plies[0]).toBe(1);
    expect([...plies].sort((a, b) => a - b)).toEqual(plies);
    // 100 white moves → every 10/3 → gaps of 6 or 8 plies only
    const gaps = plies.slice(1).map((p, i) => p - plies[i]!);
    expect(new Set(gaps)).toEqual(new Set([6, 8]));
    expect(selectEloPlies(moves, 'white', 0).map((m) => m.ply)).toEqual(plies);
    expect(selectEloPlies(moves, 'white', 0, 12)).toHaveLength(12);
  });

  it("keeps the caller's objects (generic)", () => {
    const moves = game(30).map((m) => ({ ...m, winProbLoss: m.ply }));
    const sel = selectEloPlies(moves, 'black', 0);
    expect(sel[0]).toBe(moves[1]);
    expect(sel[0]!.winProbLoss).toBe(2);
  });
});

describe('speedClass', () => {
  it.each([
    ['15+0', 'bullet'],
    ['60+0', 'bullet'],
    ['120+1', 'bullet'],
    ['180+0', 'blitz'],
    ['180+2', 'blitz'],
    ['300+3', 'blitz'],
    ['420+1', 'blitz'], // 460 s
    ['420+2', 'rapid'], // 500 s
    ['600+0', 'rapid'],
    ['600+5', 'rapid'],
    ['900+10', 'rapid'],
    ['1500+0', 'classical'],
    ['1800+20', 'classical'],
    ['600', 'rapid'],
    ['40/7200:3600', 'classical'],
    [' 180+2 ', 'blitz'],
  ] as const)('%s → %s', (tc, cls) => {
    expect(speedClass(tc)).toBe(cls);
  });

  it('missing or unparsable values are unknown', () => {
    for (const tc of [undefined, '', '-', '?', 'blitz', '0+0', '3m+2s', '180+']) {
      expect(speedClass(tc)).toBe('unknown');
    }
  });
});

describe('fallbackElo', () => {
  const table: EloCalibration = {
    version: 1,
    source: { month: 'provisional', games: 0 },
    speeds: {
      blitz: {
        knots: [
          [2, 2400],
          [5, 1900],
          [10, 1400],
          [20, 900],
        ],
        residualSd: 260,
      },
      unknown: {
        knots: [
          [0, 3000],
          [40, 300],
        ],
        residualSd: 10,
      },
    },
  };

  it('interpolates linearly between knots and rounds to 50', () => {
    expect(fallbackElo(5, 'blitz', table)).toEqual({ rating: 1900, sd: 250 });
    expect(fallbackElo(7.5, 'blitz', table).rating).toBe(1650);
    expect(fallbackElo(6, 'blitz', table).rating).toBe(1800);
    expect(fallbackElo(6.2, 'blitz', table).rating).toBe(1800); // 1780 → 1800
    expect(fallbackElo(15, 'blitz', table).rating).toBe(1150);
  });

  it('is flat beyond the ends and clamps to 600…2600', () => {
    expect(fallbackElo(0, 'blitz', table).rating).toBe(2400);
    expect(fallbackElo(99, 'blitz', table).rating).toBe(900);
    expect(fallbackElo(0, 'unknown', table).rating).toBe(2600);
    expect(fallbackElo(40, 'unknown', table).rating).toBe(600);
    expect(fallbackElo(Number.NaN, 'unknown', table).rating).toBe(2600);
  });

  it('uses the unknown curve for a speed class without one; sd is at least 50', () => {
    expect(fallbackElo(20, 'rapid', table)).toEqual(fallbackElo(20, 'unknown', table));
    expect(fallbackElo(20, 'unknown', table)).toEqual({ rating: 1650, sd: 50 });
  });
});

describe('schemas', () => {
  it('EloCalibrationSchema accepts a valid table and rejects malformed ones', () => {
    const ok: EloCalibration = {
      version: 1,
      source: { month: '2026-09', games: 104_233, sha256: 'a'.repeat(64) },
      speeds: {
        blitz: {
          knots: [
            [1, 2300],
            [8, 1500],
          ],
          residualSd: 240,
        },
        unknown: {
          knots: [
            [1, 2200],
            [8, 1500],
          ],
          residualSd: 280,
        },
      },
    };
    expect(EloCalibrationSchema.safeParse(ok).success).toBe(true);
    expect(
      EloCalibrationSchema.safeParse({ ...ok, source: { month: 'provisional', games: 0 } }).success,
    ).toBe(true);
    const bad = [
      { ...ok, version: 2 },
      { ...ok, source: { ...ok.source, month: 'Sept' } },
      { ...ok, source: { ...ok.source, sha256: 'xyz' } },
      { ...ok, speeds: { blitz: ok.speeds.blitz } },
      { ...ok, speeds: { ...ok.speeds, unknown: { knots: [[1, 2000]], residualSd: 1 } } },
      {
        ...ok,
        speeds: {
          ...ok.speeds,
          unknown: {
            knots: [
              [8, 1500],
              [1, 2200],
            ],
            residualSd: 1,
          },
        },
      },
      {
        ...ok,
        speeds: {
          ...ok.speeds,
          unknown: {
            knots: [
              [1, 1500],
              [1, 1400],
            ],
            residualSd: 1,
          },
        },
      },
      {
        ...ok,
        speeds: {
          ...ok.speeds,
          unknown: {
            knots: [
              [1, 2000],
              [101, 1],
            ],
            residualSd: 1,
          },
        },
      },
      {
        ...ok,
        speeds: {
          ...ok.speeds,
          unknown: {
            knots: [
              [1, 2000],
              [2, 1],
            ],
            residualSd: -1,
          },
        },
      },
    ];
    for (const b of bad) expect(EloCalibrationSchema.safeParse(b).success).toBe(false);
  });

  it('EloEstimateSchema bounds the stored estimate', () => {
    const e = { method: 'maia', rating: 1540, positions: 24, exact: true, maiaVersion: 1 };
    expect(EloEstimateSchema.safeParse(e).success).toBe(true);
    expect(EloEstimateSchema.safeParse({ ...e, rating: 800, low: 800, high: 2200 }).success).toBe(
      true,
    );
    expect(EloEstimateSchema.safeParse({ ...e, rating: 799 }).success).toBe(false);
    expect(EloEstimateSchema.safeParse({ ...e, high: 2201 }).success).toBe(false);
    expect(EloEstimateSchema.safeParse({ ...e, positions: -1 }).success).toBe(false);
  });
});
