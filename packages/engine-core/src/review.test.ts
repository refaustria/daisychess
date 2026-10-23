import { describe, expect, it } from 'vitest';
import { cpToWinProbability } from './eval.js';
import {
  CLASSIFICATION_THRESHOLDS,
  MOVE_CLASSES,
  classifyMove,
  gameAccuracy,
  moveAccuracy,
  reviewGame,
} from './review.js';

/** cp (White POV) whose win probability is `p`. */
// win = 50 + 50*(2/(1+e^-kx)-1) = 100/(1+e^-kx)  =>  x = ln(p/(100-p))/k
const cp = (p: number): number => Math.log(p / (100 - p)) / 0.00368208;

describe('helpers', () => {
  it('cp helper inverts cpToWinProbability', () => {
    expect(cpToWinProbability(cp(60))).toBeCloseTo(60, 6);
  });
});

/** White moves from 50% to `50 - loss`. */
const whiteLoss = (loss: number) =>
  classifyMove({
    evalBefore: { cp: 0 },
    evalAfter: { cp: cp(50 - loss) },
    mover: 'white',
    playedIsBest: false,
  });

describe('classifyMove thresholds', () => {
  it('exports the thresholds', () => {
    expect(CLASSIFICATION_THRESHOLDS).toEqual({
      best: 0.5,
      excellent: 2,
      good: 5,
      inaccuracy: 10,
      mistake: 20,
    });
    expect(MOVE_CLASSES).toHaveLength(7);
  });

  it.each([
    [0, 'best'],
    [0.49, 'best'],
    [0.5, 'excellent'],
    [1.999999, 'excellent'],
    [2.01, 'good'],
    [4.999999, 'good'],
    [5.01, 'inaccuracy'],
    [9.999999, 'inaccuracy'],
    [10.01, 'mistake'],
    [19.999999, 'mistake'],
    [20.1, 'blunder'],
  ] as const)('loss %s => %s', (loss, expected) => {
    expect(whiteLoss(loss)).toBe(expected);
  });

  it('a gaining move is best', () => {
    expect(
      classifyMove({
        evalBefore: { cp: 0 },
        evalAfter: { cp: 300 },
        mover: 'white',
        playedIsBest: false,
      }),
    ).toBe('best');
  });

  it('playedIsBest wins over loss', () => {
    expect(
      classifyMove({
        evalBefore: { cp: 0 },
        evalAfter: { cp: -900 },
        mover: 'white',
        playedIsBest: true,
      }),
    ).toBe('best');
  });

  it('is symmetric for black', () => {
    // Black blunders: White POV eval rises from 0 to +600.
    expect(
      classifyMove({
        evalBefore: { cp: 0 },
        evalAfter: { cp: 600 },
        mover: 'black',
        playedIsBest: false,
      }),
    ).toBe('blunder');
    // Black boundary: White POV win goes 50 -> 50 + loss.
    expect(
      classifyMove({
        evalBefore: { cp: 0 },
        evalAfter: { cp: cp(54) },
        mover: 'black',
        playedIsBest: false,
      }),
    ).toBe('good');
    // Black gaining (eval drops for White) is best.
    expect(
      classifyMove({
        evalBefore: { cp: 0 },
        evalAfter: { cp: -300 },
        mover: 'black',
        playedIsBest: false,
      }),
    ).toBe('best');
  });

  it('detects forced moves', () => {
    expect(
      classifyMove({
        evalBefore: { cp: 0 },
        evalAfter: { cp: -900 },
        mover: 'white',
        playedIsBest: false,
        legalMoves: 1,
      }),
    ).toBe('forced');
    expect(
      classifyMove({
        evalBefore: { cp: 0 },
        evalAfter: { cp: 0 },
        mover: 'white',
        playedIsBest: false,
        legalMoves: 2,
      }),
    ).toBe('best');
  });

  it('mate handling', () => {
    // keeping a mate (white)
    expect(
      classifyMove({
        evalBefore: { mate: 3 },
        evalAfter: { mate: 5 },
        mover: 'white',
        playedIsBest: false,
      }),
    ).toBe('best');
    // keeping a mate (black)
    expect(
      classifyMove({
        evalBefore: { mate: -3 },
        evalAfter: { mate: -2 },
        mover: 'black',
        playedIsBest: false,
      }),
    ).toBe('best');
    // throwing away a mate into a roughly equal position
    expect(
      classifyMove({
        evalBefore: { mate: 3 },
        evalAfter: { cp: 0 },
        mover: 'white',
        playedIsBest: false,
      }),
    ).toBe('blunder');
    // throwing away a mate but still clearly winning: modest loss
    expect(
      classifyMove({
        evalBefore: { mate: 3 },
        evalAfter: { cp: 600 },
        mover: 'white',
        playedIsBest: false,
      }),
    ).toBe('inaccuracy');
    // getting mated faster is not a loss
    expect(
      classifyMove({
        evalBefore: { mate: -5 },
        evalAfter: { mate: -2 },
        mover: 'white',
        playedIsBest: false,
      }),
    ).toBe('best');
    // delivering checkmate (mate 0) is best
    expect(
      classifyMove({
        evalBefore: { mate: 1 },
        evalAfter: { mate: 0 },
        mover: 'white',
        playedIsBest: false,
      }),
    ).toBe('best');
    expect(
      classifyMove({
        evalBefore: { mate: -1 },
        evalAfter: { mate: 0 },
        mover: 'black',
        playedIsBest: false,
      }),
    ).toBe('best');
  });
});

describe('moveAccuracy', () => {
  it('is ~100 for equal or improved win probability', () => {
    expect(moveAccuracy(50, 50)).toBeCloseTo(100, 2);
    expect(moveAccuracy(50, 80)).toBeCloseTo(100, 2);
    expect(moveAccuracy(50, 80)).toBeLessThanOrEqual(100);
  });

  it('matches the formula for a 10% loss', () => {
    const expected = 103.1668 * Math.exp(-0.4354) - 3.1669;
    expect(moveAccuracy(60, 50)).toBeCloseTo(expected, 5);
    expect(moveAccuracy(60, 50)).toBeCloseTo(63.6, 0);
  });

  it('is clamped to [0, 100]', () => {
    expect(moveAccuracy(100, 0)).toBeGreaterThanOrEqual(0);
    expect(moveAccuracy(100, 0)).toBeLessThan(2);
  });
});

describe('gameAccuracy', () => {
  it('is the mean rounded to 1 decimal', () => {
    expect(gameAccuracy([100, 50])).toBe(75);
    expect(gameAccuracy([100, 90, 81])).toBe(90.3);
  });
  it('is 0 for no moves', () => {
    expect(gameAccuracy([])).toBe(0);
  });
});

describe('reviewGame', () => {
  const W = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const B = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  it('reviews a 3-move synthetic game', () => {
    const summary = reviewGame({
      positions: [
        { fen: W, eval: { cp: 0 }, bestMove: 'e2e4' },
        { fen: B, eval: { cp: 0 }, bestMove: 'e7e5' },
        { fen: W, eval: { cp: 600 }, bestMove: 'g1f3' },
        { fen: B, eval: { cp: 600 } },
      ],
      moves: [
        { uci: 'e2e4', san: 'e4' },
        { uci: 'a7a6', san: 'a6' },
        { uci: 'g1f3', san: 'Nf3', legalMoves: 1 },
      ],
    });
    expect(summary.moves).toHaveLength(3);
    expect(summary.moves.map((m) => m.mover)).toEqual(['white', 'black', 'white']);
    expect(summary.moves.map((m) => m.ply)).toEqual([1, 2, 3]);
    expect(summary.moves.map((m) => m.classification)).toEqual(['best', 'blunder', 'forced']);
    expect(summary.moves[1]!.winProbLoss).toBeGreaterThan(20);
    expect(summary.moves[1]!.bestMove).toBe('e7e5');
    expect(summary.moves[0]!.san).toBe('e4');
    expect(summary.white.counts.best).toBe(1);
    expect(summary.white.counts.forced).toBe(1);
    expect(summary.black.counts.blunder).toBe(1);
    expect(summary.white.accuracy).toBeGreaterThan(99);
    expect(summary.black.accuracy).toBeLessThan(20);
  });

  it('throws on length mismatch', () => {
    expect(() =>
      reviewGame({ positions: [{ fen: W, eval: { cp: 0 } }], moves: [{ uci: 'e2e4' }] }),
    ).toThrow(/positions\.length/);
  });

  it('handles an empty game', () => {
    const s = reviewGame({ positions: [{ fen: W, eval: { cp: 0 } }], moves: [] });
    expect(s.moves).toEqual([]);
    expect(s.white.accuracy).toBe(0);
  });
});
