import type { MoveClass, ReviewSummary } from '@daisychess/engine-core';
import { describe, expect, it } from 'vitest';
import { timedMoves } from '../clock/testMoves';
import { START_FEN } from '../store/gameStore';
import {
  formatDuration,
  isTimeTrouble,
  moveTime,
  sideTimeStats,
  TIME_TROUBLE_FRACTION,
  TIME_TROUBLE_MIN_MS,
  timeTroublePlies,
  timeTroubleThresholdMs,
  timeUsedText,
} from './timeUsage';

const tc = { initialMs: 180_000, incrementMs: 2_000 };
const moves = timedMoves(
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4'],
  [
    { remainingMs: 180_000, spentMs: 0 },
    { remainingMs: 180_000, spentMs: 0 },
    { remainingMs: 140_000, spentMs: 42_000 },
    { remainingMs: 25_000, spentMs: 157_000 },
    { remainingMs: 20_000, spentMs: 122_000 },
    undefined,
    { spentMs: 3_000 },
  ],
);
const game = { startFen: START_FEN, moves, timeControl: tc };

const summary = (classes: Partial<Record<number, MoveClass>>): ReviewSummary =>
  ({
    moves: moves.map((m, i) => ({
      ply: i + 1,
      mover: i % 2 === 0 ? 'white' : 'black',
      uci: `${m.from}${m.to}`,
      san: m.san,
      classification: classes[i + 1] ?? 'best',
      evalBefore: { cp: 0 },
      evalAfter: { cp: 0 },
      winProbBefore: 50,
      winProbAfter: 50,
      winProbLoss: 0,
      accuracy: 100,
    })),
  }) as unknown as ReviewSummary; // only `moves` is read

describe('timeTroubleThresholdMs', () => {
  it('is the larger of 10 % of the initial time and 30 s', () => {
    expect(TIME_TROUBLE_FRACTION).toBe(0.1);
    expect(TIME_TROUBLE_MIN_MS).toBe(30_000);
    expect(timeTroubleThresholdMs(180_000)).toBe(30_000);
    expect(timeTroubleThresholdMs(900_000)).toBe(90_000);
    expect(timeTroubleThresholdMs(undefined)).toBe(30_000);
  });
});

describe('formatDuration', () => {
  it('whole seconds, tenths only below 10 s when present', () => {
    expect(formatDuration(42_000)).toBe('0:42');
    expect(formatDuration(42_900)).toBe('0:42');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_000)).toBe('0:03');
    expect(formatDuration(3_400)).toBe('0:03.4');
    expect(formatDuration(0)).toBe('0:00');
  });
});

describe('moveTime / timeUsedText', () => {
  it('spent, remaining and share of the time before the move', () => {
    expect(moveTime(game, 3)).toEqual({
      remainingMs: 140_000,
      spentMs: 42_000,
      beforeMs: 180_000,
      shareOfRemaining: 42_000 / 180_000,
    });
    expect(timeUsedText(moveTime(game, 3))).toBe('Used 0:42 (23% of remaining) · 2:20 left');
    expect(timeUsedText(moveTime(game, 5))).toBe('Used 2:02 (87% of remaining) · 0:20 left');
  });

  it('falls back to remaining + spent − increment for the time before', () => {
    const g = { ...game, moves: moves.map((m, i) => (i === 2 ? { ...m, clock: undefined } : m)) };
    expect(moveTime(g, 5)?.beforeMs).toBe(140_000);
  });

  it('partial or missing data', () => {
    expect(moveTime(game, 6)).toBeUndefined();
    expect(timeUsedText(undefined)).toBeUndefined();
    // Ply 7: previous White value is known.
    expect(timeUsedText(moveTime(game, 7))).toBe('Used 0:03 (15% of remaining)');
    expect(timeUsedText({ remainingMs: 9_500 })).toBe('0:09.5 left');
  });
});

describe('time trouble', () => {
  it('flags mistakes/blunders made with little time left only', () => {
    expect(isTimeTrouble(game, { ply: 5, classification: 'blunder' })).toBe(true);
    expect(isTimeTrouble(game, { ply: 4, classification: 'mistake' })).toBe(true);
    expect(isTimeTrouble(game, { ply: 5, classification: 'inaccuracy' })).toBe(false);
    expect(isTimeTrouble(game, { ply: 3, classification: 'blunder' })).toBe(false);
    expect(isTimeTrouble(game, { ply: 6, classification: 'blunder' })).toBe(false);
  });

  it('uses 10 % of a long initial time', () => {
    const long = { ...game, timeControl: { initialMs: 900_000, incrementMs: 0 } };
    const m = timedMoves(['e4'], [{ remainingMs: 80_000 }]);
    expect(isTimeTrouble({ ...long, moves: m }, { ply: 1, classification: 'mistake' })).toBe(true);
  });

  it('timeTroublePlies and per-side stats', () => {
    const s = summary({ 3: 'mistake', 4: 'blunder', 5: 'mistake' });
    expect([...timeTroublePlies(game, s)]).toEqual([4, 5]);
    const stats = sideTimeStats(game, s);
    expect(stats.white).toEqual({
      timedMoves: 4,
      avgMs: (0 + 42_000 + 122_000 + 3_000) / 4,
      longest: { ply: 5, ms: 122_000 },
      timeTroubleMistakes: 1,
    });
    expect(stats.black).toEqual({
      timedMoves: 2,
      avgMs: 157_000 / 2,
      longest: { ply: 4, ms: 157_000 },
      timeTroubleMistakes: 1,
    });
    expect(sideTimeStats({ ...game, moves: timedMoves(['e4'], []) }).white).toEqual({
      timedMoves: 0,
      timeTroubleMistakes: 0,
    });
  });
});
