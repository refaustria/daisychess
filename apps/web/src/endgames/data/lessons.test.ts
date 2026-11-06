import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  LESSON_GROUPS,
  LessonSchema,
  initialLesson,
  materialKey,
  tablebaseEligible,
} from '@daisychess/endgames';
import { LESSONS } from './lessons';
import verdictFile from './lessons.verdicts.json';

interface Verdict {
  fen: string;
  category: string;
  dtm: number | null;
  dtz: number | null;
  moves: number;
  keepers: number;
}

const verdicts = verdictFile.verdicts as Record<string, Verdict>;

const EXPECTED_ORDER = [
  'kq-vs-k',
  'kr-vs-k',
  'kbb-vs-k',
  'kbn-vs-k',
  'kpk-opposition',
  'kpk-key-squares',
  'kpk-rule-of-square',
  'kpk-rook-pawn',
  'qvp-knight-pawn',
  'qvp-rook-pawn',
  'lucena',
  'philidor',
  'vancura',
  'rp-cut-off',
  'rp-short-side',
  'rp-a-pawn',
];

describe('course', () => {
  it('has at least 16 lessons in course order with unique ids', () => {
    expect(LESSONS.length).toBeGreaterThanOrEqual(16);
    expect(LESSONS.map((l) => l.id)).toEqual(EXPECTED_ORDER);
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(LESSONS.length);
  });

  it('covers every group, and only K+B+N vs K is advanced', () => {
    for (const g of LESSON_GROUPS) expect(LESSONS.some((l) => l.group === g)).toBe(true);
    expect(LESSONS.filter((l) => l.advanced).map((l) => l.id)).toEqual(['kbn-vs-k']);
  });

  it('has a verdict for every lesson and no stray verdicts', () => {
    expect(Object.keys(verdicts).sort()).toEqual(LESSONS.map((l) => l.id).sort());
  });

  it('keeps groups contiguous (course order)', () => {
    const groups = LESSONS.map((l) => l.group);
    const changes = groups.filter((g, i) => i > 0 && g !== groups[i - 1]).length;
    expect(changes).toBe(new Set(groups).size - 1);
  });
});

describe.each(LESSONS.map((l) => [l.id, l] as const))('lesson %s', (_id, lesson) => {
  it('passes the schema', () => {
    expect(LessonSchema.safeParse(lesson).success).toBe(true);
  });

  it('starts from a legal position with the user to move, ≤ 7 pieces and no castling', () => {
    const chess = new Chess(lesson.fen);
    expect(chess.turn()).toBe(lesson.userSide === 'white' ? 'w' : 'b');
    expect(chess.isGameOver()).toBe(false);
    expect(tablebaseEligible(lesson.fen)).toBe(true);
    expect(lesson.fen.split(' ')[2]).toBe('-');
    expect(chess.board().flat().filter(Boolean).length).toBeLessThanOrEqual(7);
    expect(initialLesson(lesson).phase).toBe('intro');
  });

  it('lists the start material key among its tables', () => {
    expect(lesson.tables).toContain(materialKey(lesson.fen));
  });

  it('has 2-4 sentences of text and 2-4 hints in our own words', () => {
    const sentences = lesson.text.split(/(?<=[.!?])\s+(?=[A-Z])/);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences.length).toBeLessThanOrEqual(4);
    expect(lesson.hints.length).toBeGreaterThanOrEqual(2);
    expect(lesson.hints.length).toBeLessThanOrEqual(4);
    expect(lesson.text.endsWith('.')).toBe(true);
    for (const h of lesson.hints) expect(h.endsWith('.')).toBe(true);
  });

  it('has a committed verdict that matches the goal', () => {
    const v = verdicts[lesson.id];
    expect(v).toBeDefined();
    expect(v!.fen).toBe(lesson.fen);
    expect(v!.category).toBe(lesson.goal === 'win' ? 'win' : 'draw');
    expect(v!.keepers).toBeGreaterThanOrEqual(1);
    expect(v!.keepers).toBeLessThanOrEqual(v!.moves);
    if (lesson.goal === 'win') {
      expect(v!.dtm).not.toBeNull();
      expect(lesson.budget).toBeGreaterThanOrEqual(Math.ceil(Math.abs(v!.dtm!) / 2) + 4);
    } else {
      // A draw is held with the opponent pressing: some, but not all, moves must fail.
      expect(v!.dtm === null || v!.dtm === 0).toBe(true);
      expect(v!.keepers).toBeLessThan(v!.moves);
    }
  });
});

describe('the point of the lessons', () => {
  it('Philidor, Vancura and the defensive rook endings leave few drawing moves', () => {
    for (const id of ['philidor', 'vancura', 'rp-short-side', 'rp-a-pawn']) {
      expect(verdicts[id]!.keepers, id).toBeLessThanOrEqual(4);
    }
  });

  it('the pawn lessons that depend on one precise king move have a single winning move', () => {
    expect(verdicts['kpk-opposition']!.keepers).toBe(1);
    expect(verdicts['kpk-key-squares']!.keepers).toBe(1);
  });
});
