import { describe, expect, it } from 'vitest';
import { PuzzleIndexSchema, PuzzleRowSchema, ShardSchema, StarterSchema } from './schemas.js';

const row = [
  '00008',
  'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
  'f2g3 e6e7',
  1811,
  76,
  [0],
  [],
  '',
];

describe('PuzzleRowSchema', () => {
  it('accepts a compact row', () => {
    expect(PuzzleRowSchema.safeParse(row).success).toBe(true);
  });
  it('rejects malformed rows', () => {
    const bad = (i: number, v: unknown) => {
      const r: unknown[] = [...row];
      r[i] = v;
      return PuzzleRowSchema.safeParse(r).success;
    };
    expect(bad(0, '')).toBe(false);
    expect(bad(1, 'x'.repeat(101))).toBe(false);
    expect(bad(2, 'f2g3')).toBe(false);
    expect(bad(2, 'f2g3 e6e7 zz')).toBe(false);
    expect(bad(3, 18.5)).toBe(false);
    expect(bad(5, [-1])).toBe(false);
    expect(PuzzleRowSchema.safeParse(row.slice(0, 7)).success).toBe(false);
  });
});

describe('ShardSchema', () => {
  it('accepts a shard and rejects a foreign format or band', () => {
    const shard = { format: 1, dataset: 'abc', band: 1800, rows: [row] };
    expect(ShardSchema.safeParse(shard).success).toBe(true);
    expect(ShardSchema.safeParse({ ...shard, format: 2 }).success).toBe(false);
    expect(ShardSchema.safeParse({ ...shard, band: 1850 }).success).toBe(false);
    expect(ShardSchema.safeParse({ ...shard, band: 3000 }).success).toBe(false);
  });
});

describe('PuzzleIndexSchema', () => {
  const index = {
    format: 1,
    dataset: { source: 'u', sha256: 'abc', lastModified: 'x', builtAt: 'y', total: 1 },
    themes: ['fork'],
    openings: ['Italian_Game'],
    families: [0],
    bandSize: 100,
    shards: [
      {
        file: 'shards/1800-0123456789abcdef.json',
        band: 1800,
        count: 1,
        bytes: 99,
        themes: { '0': 1 },
        families: {},
      },
    ],
    counts: { themes: [1], openings: [0] },
  };
  it('accepts an index (JSON string keys of the count maps)', () => {
    const parsed = PuzzleIndexSchema.parse(JSON.parse(JSON.stringify(index)));
    expect(parsed.shards[0]!.themes[0]).toBe(1);
  });
  it('rejects inconsistent lists, bad files and bad count keys', () => {
    expect(
      PuzzleIndexSchema.safeParse({ ...index, counts: { themes: [], openings: [0] } }).success,
    ).toBe(false);
    expect(PuzzleIndexSchema.safeParse({ ...index, families: [3] }).success).toBe(false);
    const shard = index.shards[0]!;
    expect(
      PuzzleIndexSchema.safeParse({ ...index, shards: [{ ...shard, file: '../etc/passwd' }] })
        .success,
    ).toBe(false);
    expect(
      PuzzleIndexSchema.safeParse({ ...index, shards: [{ ...shard, themes: { x: 1 } }] }).success,
    ).toBe(false);
  });
});

describe('StarterSchema', () => {
  it('requires daily indexes within the rows', () => {
    const starter = {
      format: 1,
      dataset: 'abc',
      themes: ['fork'],
      openings: [],
      rows: [row],
      daily: [0],
    };
    expect(StarterSchema.safeParse(starter).success).toBe(true);
    expect(StarterSchema.safeParse({ ...starter, daily: [1] }).success).toBe(false);
  });
});
