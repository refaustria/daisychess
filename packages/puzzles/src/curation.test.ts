import { describe, expect, it } from 'vitest';
import {
  buildIndex,
  buildStarter,
  hardFilter,
  pickDailyPool,
  pickStarter,
  seededRandom,
  selectCurated,
  shardByBand,
} from './curation.js';
import type { CsvPuzzle } from './csv.js';
import { bandOf, buildDictionary, decodeRow } from './rows.js';
import { PuzzleIndexSchema, ShardSchema, StarterSchema } from './schemas.js';
import { fixturePuzzles } from '../test/fixture.js';

let n = 0;
const mk = (
  rating: number,
  nbPlays: number,
  themes: string[] = ['short'],
  extra: Partial<CsvPuzzle> = {},
): CsvPuzzle => ({
  id: `p${String(n++).padStart(5, '0')}`,
  fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
  moves: ['a1a2', 'h1h2'],
  rating,
  rd: 70,
  popularity: 96,
  nbPlays,
  themes,
  openings: [],
  game: '',
  ...extra,
});

describe('hardFilter', () => {
  it('keeps popular, well-rated, often played puzzles only', () => {
    const ok = mk(1500, 300, ['short'], { popularity: 90, rd: 80 });
    expect(hardFilter(ok)).toBe(true);
    expect(hardFilter({ ...ok, popularity: 89 })).toBe(false);
    expect(hardFilter({ ...ok, rd: 81 })).toBe(false);
    expect(hardFilter({ ...ok, nbPlays: 299 })).toBe(false);
    expect(hardFilter({ ...ok, rating: 499 })).toBe(false);
  });
  it('matches the fixture composition', () => {
    expect(fixturePuzzles.filter(hardFilter)).toHaveLength(191);
  });
});

describe('seededRandom', () => {
  it('is deterministic per seed and within [0, 1)', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRandom(43)()).not.toBe(xs[0]);
  });
});

describe('selectCurated', () => {
  it('keeps the most played per band, then tops up rare themes', () => {
    const a = [mk(1500, 900), mk(1520, 800), mk(1550, 700), mk(1600, 100)];
    const rare = [
      mk(1510, 50, ['short', 'enPassant']),
      mk(1590, 40, ['enPassant']),
      mk(1580, 30, ['enPassant']),
    ];
    const out = selectCurated([...a, ...rare], { quotaPerBand: 2, themeFloor: 2 });
    const ids = out.map((p) => p.id);
    expect(ids).toContain(a[0]!.id);
    expect(ids).toContain(a[1]!.id);
    expect(ids).not.toContain(a[2]!.id);
    expect(ids).toContain(a[3]!.id); // other band
    expect(ids).toContain(rare[0]!.id); // most played enPassant rows
    expect(ids).toContain(rare[1]!.id);
    expect(ids).not.toContain(rare[2]!.id);
    expect(ids).toEqual([...ids].sort()); // sorted by id
  });

  it('is deterministic on the fixture and respects the quota', () => {
    const hard = fixturePuzzles.filter(hardFilter);
    const out = selectCurated(hard, { quotaPerBand: 3, themeFloor: 2 });
    expect(selectCurated([...hard].reverse(), { quotaPerBand: 3, themeFloor: 2 })).toEqual(out);
    const themes = new Set(hard.flatMap((p) => p.themes));
    for (const t of themes) {
      const have = out.filter((p) => p.themes.includes(t)).length;
      const avail = hard.filter((p) => p.themes.includes(t)).length;
      expect(have).toBeGreaterThanOrEqual(Math.min(2, avail));
    }
  });

  it('defaults to the production quotas', () => {
    const hard = fixturePuzzles.filter(hardFilter);
    expect(selectCurated(hard)).toHaveLength(hard.length);
  });
});

describe('pickStarter', () => {
  it('limits bands to 600…2500 and trims to the size without breaking theme floors', () => {
    const pool: CsvPuzzle[] = [];
    for (let b = 400; b <= 2900; b += 100)
      for (let i = 0; i < 10; i++) pool.push(mk(b + i, 1000 - i));
    for (let i = 0; i < 3; i++) pool.push(mk(1200 + i, 5 + i, ['castling']));
    const out = pickStarter(pool, { size: 50, quotaPerBand: 4, themeFloor: 2 });
    expect(out).toHaveLength(50);
    expect(out.every((p) => bandOf(p.rating) >= 600 && bandOf(p.rating) <= 2500)).toBe(true);
    expect(out.filter((p) => p.themes.includes('castling'))).toHaveLength(2);
    // Trimmed from the least played rows: the most played of each band survive.
    const bands = new Set(out.map((p) => bandOf(p.rating)));
    expect(bands.size).toBe(20);
  });

  it('cannot trim below what the theme floors need', () => {
    const pool = [mk(1000, 10, ['a']), mk(1100, 10, ['b']), mk(1200, 10, ['c'])];
    expect(pickStarter(pool, { size: 1, quotaPerBand: 1, themeFloor: 1 })).toHaveLength(3);
  });

  it('runs on the fixture with the defaults', () => {
    const out = pickStarter(selectCurated(fixturePuzzles.filter(hardFilter)));
    expect(out.length).toBeGreaterThan(100);
    expect(out.length).toBeLessThanOrEqual(6000);
  });
});

describe('pickDailyPool', () => {
  it('picks eligible rows in a seeded order', () => {
    const rows = [
      mk(1300, 1, ['short'], { popularity: 95, rd: 75 }),
      mk(2000, 1, ['short'], { popularity: 99, rd: 60 }),
      mk(1299, 1),
      mk(2001, 1),
      mk(1500, 1, ['short'], { popularity: 94 }),
      mk(1500, 1, ['short'], { rd: 76 }),
      ...Array.from({ length: 20 }, (_, i) => mk(1400 + i, 1)),
    ];
    const pool = pickDailyPool(rows, { size: 10, seed: 1 });
    expect(pool).toHaveLength(10);
    expect(new Set(pool).size).toBe(10);
    expect(pool.every((i) => ![2, 3, 4, 5].includes(i))).toBe(true);
    expect(pickDailyPool(rows, { size: 10, seed: 1 })).toEqual(pool);
    expect(pickDailyPool(rows, { size: 10, seed: 2 })).not.toEqual(pool);
    const all = pickDailyPool(rows);
    expect([...all].sort((a, b) => a - b)).toEqual([
      0,
      1,
      ...Array.from({ length: 20 }, (_, i) => i + 6),
    ]);
  });
});

describe('shardByBand + buildIndex + buildStarter (fixture pipeline)', () => {
  const curated = selectCurated(fixturePuzzles.filter(hardFilter));
  const dict = buildDictionary(curated);

  it('splits bands into equal parts of ≤ maxRows rows sorted by id', () => {
    const shards = shardByBand(curated, dict, { maxRows: 4 });
    expect(shards.reduce((s, x) => s + x.rows.length, 0)).toBe(curated.length);
    for (const s of shards) {
      expect(s.rows.length).toBeLessThanOrEqual(4);
      const ids = s.rows.map((r) => r[0]);
      expect(ids).toEqual([...ids].sort());
      for (const r of s.rows) expect(bandOf(r[3])).toBe(s.band);
      expect(
        ShardSchema.safeParse({ format: 1, dataset: 'd', band: s.band, rows: s.rows }).success,
      ).toBe(true);
    }
    const bands = shards.map((s) => s.band);
    expect(bands).toEqual([...bands].sort((a, b) => a - b));
    // 9 rows with max 4 → 3 + 3 + 3, not 4 + 4 + 1
    const nine = shardByBand(
      Array.from({ length: 9 }, () => mk(1500, 1)),
      buildDictionary([mk(1, 1)]),
      { maxRows: 4 },
    );
    expect(nine.map((s) => s.rows.length)).toEqual([3, 3, 3]);
    expect(() => shardByBand(curated, dict, { maxRows: 0 })).toThrow(RangeError);
  });

  it('indexes per-shard theme and family counts and global counts', () => {
    const drafts = shardByBand(curated, dict, { maxRows: 10 });
    const shards = drafts.map((d, i) => ({
      ...d,
      file: `shards/${d.band}-${i.toString(16).padStart(16, '0')}.json`,
      bytes: JSON.stringify(d.rows).length,
    }));
    const index = buildIndex({
      dataset: {
        source: 'https://database.lichess.org/lichess_db_puzzle.csv.zst',
        sha256: 'f'.repeat(64),
        lastModified: 'x',
        builtAt: '2026-10-26',
      },
      dictionary: dict,
      shards,
    });
    const parsed = PuzzleIndexSchema.parse(JSON.parse(JSON.stringify(index)));
    expect(parsed.dataset.total).toBe(curated.length);
    const themeIdx = parsed.themes.indexOf('mateIn1');
    expect(parsed.counts.themes[themeIdx]).toBe(
      curated.filter((p) => p.themes.includes('mateIn1')).length,
    );
    expect(parsed.shards.reduce((s, x) => s + (x.themes[themeIdx] ?? 0), 0)).toBe(
      parsed.counts.themes[themeIdx],
    );
    // family counts: first tags only
    const withOpening = curated.filter((p) => p.openings.length > 0);
    const famTotal = parsed.shards.reduce(
      (s, x) => s + Object.values(x.families).reduce((a, b) => a + b, 0),
      0,
    );
    expect(famTotal).toBe(withOpening.length);
    for (const f of parsed.families)
      expect(curated.some((p) => p.openings[0] === parsed.openings[f])).toBe(true);
    expect(parsed.counts.openings.reduce((a, b) => a + b, 0)).toBe(
      withOpening.reduce((s, p) => s + p.openings.length, 0),
    );
    // decode a shard against the index
    const first = shards[0]!;
    expect(decodeRow(first.rows[0]!, parsed).source).toBe('lichess');
  });

  it('builds a valid starter with its own dictionary and the daily pool', () => {
    const starterRows = pickStarter(curated);
    const daily = pickDailyPool(starterRows, { size: 20 });
    const starter = buildStarter({ dataset: 'f'.repeat(64), puzzles: starterRows, daily });
    const parsed = StarterSchema.parse(JSON.parse(JSON.stringify(starter)));
    expect(parsed.rows).toHaveLength(starterRows.length);
    expect(parsed.daily).toEqual(daily);
    expect(decodeRow(parsed.rows[0]!, parsed).id).toBe(starterRows[0]!.id);
    expect(() =>
      buildStarter({ dataset: 'x', puzzles: starterRows, daily: [starterRows.length] }),
    ).toThrow(RangeError);
  });
});
