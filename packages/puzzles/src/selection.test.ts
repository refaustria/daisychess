import { describe, expect, it } from 'vitest';
import {
  chooseShards,
  choosePuzzle,
  dailyIndex,
  difficultyWindow,
  matchesFilter,
  rushPlan,
  shardWeight,
  utcDateKey,
} from './selection.js';
import { seededRandom } from './curation.js';
import type { Puzzle, PuzzleIndex, ShardEntry } from './schemas.js';

const puzzle = (
  id: string,
  rating: number | undefined,
  themes: string[] = [],
  openings: string[] = [],
): Puzzle => {
  const p: Puzzle = {
    id,
    fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
    moves: ['a1a2', 'h1h2'],
    themes,
    openings,
    source: 'lichess',
  };
  if (rating !== undefined) p.rating = rating;
  return p;
};

describe('difficultyWindow', () => {
  it('returns the windows of ADR-023 §5 and widens by 200 per step', () => {
    expect(difficultyWindow(1500)).toEqual({ min: 1400, max: 1700 });
    expect(difficultyWindow(1500, 'easier')).toEqual({ min: 1200, max: 1450 });
    expect(difficultyWindow(1500, 'harder')).toEqual({ min: 1650, max: 1950 });
    expect(difficultyWindow(1500, 'normal', 2)).toEqual({ min: 1000, max: 2100 });
    expect(difficultyWindow(1500.4, 'normal', -1)).toEqual({ min: 1400, max: 1700 });
  });
});

describe('matchesFilter', () => {
  const p = puzzle('a', 1500, ['fork', 'short'], ['Sicilian_Defense', 'Sicilian_Defense_Open']);
  it('matches theme and opening tags (family or variation)', () => {
    expect(matchesFilter(p)).toBe(true);
    expect(matchesFilter(p, { theme: 'fork' })).toBe(true);
    expect(matchesFilter(p, { theme: 'pin' })).toBe(false);
    expect(matchesFilter(p, { opening: 'Sicilian_Defense' })).toBe(true);
    expect(matchesFilter(p, { opening: 'Sicilian_Defense_Open', theme: 'fork' })).toBe(true);
    expect(matchesFilter(p, { opening: 'Sicilian_Defense_Najdorf_Variation' })).toBe(false);
  });
});

const entry = (
  band: number,
  count: number,
  themes: Record<number, number> = {},
  families: Record<number, number> = {},
): ShardEntry => ({
  file: `shards/${band}-${band.toString(16).padStart(16, '0')}.json`,
  band,
  count,
  bytes: count * 150,
  themes,
  families,
});
const index: PuzzleIndex = {
  format: 1,
  dataset: { source: 's', sha256: 'h', lastModified: 'm', builtAt: 'b', total: 0 },
  themes: ['fork', 'mate'],
  openings: ['Italian_Game', 'Sicilian_Defense', 'Sicilian_Defense_Open'],
  families: [0, 1],
  bandSize: 100,
  shards: [
    entry(1300, 100, { 0: 10 }, { 1: 5 }),
    entry(1400, 100, { 0: 50, 1: 20 }, { 1: 30, 0: 2 }),
    entry(1500, 100, { 1: 10 }),
    entry(1600, 100, { 0: 1 }, { 1: 1 }),
    entry(2900, 100, { 0: 5 }),
  ],
  counts: { themes: [66, 30], openings: [2, 36, 10] },
};

describe('shardWeight', () => {
  it('uses the smallest applicable count', () => {
    const s = index.shards[1]!;
    expect(shardWeight(index, s)).toBe(100);
    expect(shardWeight(index, s, { theme: 'fork' })).toBe(50);
    expect(shardWeight(index, s, { theme: 'unknown' })).toBe(0);
    expect(shardWeight(index, s, { opening: 'Sicilian_Defense_Open' })).toBe(30);
    expect(shardWeight(index, s, { opening: 'Sicilian_Defense_Open', theme: 'mate' })).toBe(20);
    expect(shardWeight(index, s, { opening: 'French_Defense' })).toBe(0);
  });
});

describe('chooseShards', () => {
  it('takes overlapping bands with matching puzzles, at most 3, without repeats', () => {
    const got = chooseShards(index, { window: { min: 1350, max: 1650 }, random: seededRandom(1) });
    expect(got).toHaveLength(3);
    expect(new Set(got.map((s) => s.file)).size).toBe(3);
    expect(got.every((s) => [1300, 1400, 1500, 1600].includes(s.band))).toBe(true);
  });
  it('skips bands without matches, excluded files and respects max', () => {
    const got = chooseShards(index, {
      window: { min: 1300, max: 1699 },
      filter: { theme: 'mate' },
      max: 5,
    });
    expect(got.map((s) => s.band).sort()).toEqual([1400, 1500]);
    const excl = chooseShards(index, {
      window: { min: 1300, max: 1699 },
      filter: { theme: 'mate' },
      exclude: new Set([index.shards[1]!.file]),
    });
    expect(excl.map((s) => s.band)).toEqual([1500]);
    expect(chooseShards(index, { window: { min: 1300, max: 1699 }, max: 1 })).toHaveLength(1);
  });
  it('treats the last band as open-ended and band edges as inclusive', () => {
    expect(chooseShards(index, { window: { min: 3100, max: 3300 } }).map((s) => s.band)).toEqual([
      2900,
    ]);
    expect(chooseShards(index, { window: { min: 1000, max: 1300 } }).map((s) => s.band)).toEqual([
      1300,
    ]);
    expect(chooseShards(index, { window: { min: 1000, max: 1299 } })).toEqual([]);
  });
  it('prefers heavier shards', () => {
    const random = seededRandom(7);
    let heavy = 0;
    for (let i = 0; i < 400; i++) {
      const [first] = chooseShards(index, {
        window: { min: 1300, max: 1699 },
        filter: { theme: 'fork' },
        max: 1,
        random,
      });
      if (first?.band === 1400) heavy++;
    }
    // weights 10 / 50 / 1 → 1400 first in ~82 % of the draws
    expect(heavy).toBeGreaterThan(280);
    expect(heavy).toBeLessThan(370);
  });
});

describe('choosePuzzle', () => {
  const list = [
    puzzle('a', 1400, ['fork']),
    puzzle('b', 1500, ['mate']),
    puzzle('c', 1900, ['fork']),
    puzzle('d', undefined, ['fork']),
  ];
  it('picks an unseen puzzle in the window that matches the filter', () => {
    const w = { min: 1350, max: 1600 };
    expect(choosePuzzle(list, { window: w, filter: { theme: 'fork' } })?.id).toBe('a');
    expect(choosePuzzle(list, { window: w, seen: new Set(['a']) })?.id).toBe('b');
    expect(choosePuzzle(list, { window: w, seen: (id) => id !== 'b' })?.id).toBe('b');
    expect(choosePuzzle(list, { window: w, seen: new Set(['a', 'b']) })).toBeUndefined();
    expect(
      choosePuzzle(list, {
        window: { min: 0, max: 5000 },
        filter: { theme: 'fork' },
        random: () => 0.9999999,
      })?.id,
    ).toBe('c');
  });
});

describe('dailyIndex / utcDateKey', () => {
  it('counts days since 2026-01-01 UTC modulo the pool', () => {
    expect(dailyIndex('2026-01-01', 1000)).toBe(0);
    expect(dailyIndex('2026-01-02', 1000)).toBe(1);
    expect(dailyIndex('2026-10-26', 1000)).toBe(298);
    expect(dailyIndex('2028-09-27', 1000)).toBe(0); // 1000 days later (2028 is a leap year)
    expect(dailyIndex('2025-12-31', 1000)).toBe(999);
    expect(dailyIndex(new Date(Date.UTC(2026, 0, 2, 23, 59)), 1000)).toBe(1);
    expect(dailyIndex(new Date(Date.UTC(2026, 0, 3, 0, 0)), 7)).toBe(2);
  });
  it('rejects bad input', () => {
    expect(() => dailyIndex('2026-1-1', 10)).toThrow(RangeError);
    expect(() => dailyIndex('2026-01-01', 0)).toThrow(RangeError);
    expect(() => dailyIndex(new Date(NaN), 10)).toThrow(RangeError);
  });
  it('formats the UTC date key', () => {
    expect(utcDateKey(new Date(Date.UTC(2026, 9, 26, 23, 30)))).toBe('2026-10-26');
  });
});

describe('rushPlan', () => {
  const pool = Array.from({ length: 200 }, (_, i) => puzzle(`p${i}`, 600 + i * 10));
  it('rises from 800 by 25 per puzzle, no repeats, deterministic with a seeded random', () => {
    const plan = rushPlan(pool, [], { random: seededRandom(3) });
    expect(plan).toHaveLength(60);
    expect(new Set(plan.map((p) => p.id)).size).toBe(60);
    plan.forEach((p, i) => expect(Math.abs(p.rating! - (800 + 25 * i))).toBeLessThanOrEqual(50));
    expect(rushPlan(pool, [], { random: seededRandom(3) })).toEqual(plan);
  });
  it('never uses a seen puzzle and ignores unrated ones', () => {
    const seen = pool.slice(0, 100).map((p) => p.id);
    const plan = rushPlan([...pool, puzzle('x', undefined)], seen, { spread: 1 });
    expect(plan.some((p) => seen.includes(p.id) || p.id === 'x')).toBe(false);
    expect(plan[0]!.rating).toBe(1600); // nearest available to 800
  });
  it('clamps to the available range and stops when the pool runs out', () => {
    const small = [puzzle('a', 2000), puzzle('b', 2100), puzzle('a', 2000)];
    const plan = rushPlan(small, [], { spread: 1 });
    expect(plan.map((p) => p.id)).toEqual(['a', 'b']);
    expect(rushPlan([], [])).toEqual([]);
  });
});
