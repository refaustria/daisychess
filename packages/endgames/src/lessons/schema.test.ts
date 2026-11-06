import { describe, expect, it } from 'vitest';
import { LessonSchema, MaterialKeySchema } from './schema.js';

const lesson = {
  id: 'kq-vs-k',
  group: 'basic_mates',
  title: 'K+Q vs K',
  fen: '8/8/8/4k3/8/8/8/3QK3 w - - 0 1',
  userSide: 'white',
  goal: 'win',
  budget: 14,
  tables: ['KQvK'],
  text: 'Drive the king to the edge with the queen, then bring your own king.',
  hints: ['Restrict the king to a box.', 'Bring the king closer.'],
};

describe('LessonSchema', () => {
  it('accepts a valid lesson, with and without advanced', () => {
    expect(LessonSchema.parse(lesson)).toEqual(lesson);
    expect(LessonSchema.safeParse({ ...lesson, advanced: true }).success).toBe(true);
  });

  it('rejects bad fields', () => {
    for (const bad of [
      { id: 'KQ vs K' },
      { group: 'rook_endings' },
      { goal: 'lose' },
      { budget: 0 },
      { budget: 2.5 },
      { tables: [] },
      { tables: ['KQK'] },
      { hints: [] },
      { text: '' },
      { title: '' },
    ]) {
      expect(LessonSchema.safeParse({ ...lesson, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it('rejects an illegal FEN, the wrong side to move, castling rights and > 7 pieces', () => {
    const fens = [
      'not a fen',
      '8/8/8/4k3/8/8/8/3QK3 b - - 0 1',
      'r3k3/8/8/8/8/8/8/R3K3 w Qq - 0 1',
      '8/5pp1/8/4k3/r7/8/4PP2/R3K3 w - - 0 1',
    ];
    for (const fen of fens) {
      expect(LessonSchema.safeParse({ ...lesson, fen }).success, fen).toBe(false);
    }
    expect(
      LessonSchema.safeParse({
        ...lesson,
        fen: '8/8/8/4k3/8/8/8/3QK3 b - - 0 1',
        userSide: 'black',
      }).success,
    ).toBe(true);
  });
});

describe('MaterialKeySchema', () => {
  it('accepts Syzygy names only', () => {
    expect(MaterialKeySchema.safeParse('KRPvKR').success).toBe(true);
    expect(MaterialKeySchema.safeParse('KvK').success).toBe(true);
    expect(MaterialKeySchema.safeParse('KRPvKR.rtbw').success).toBe(false);
    expect(MaterialKeySchema.safeParse('krpvkr').success).toBe(false);
  });
});
