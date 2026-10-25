import { describe, expect, it } from 'vitest';
import { START_FEN } from '../store/gameStore';
import { hasClockData, initialTimeOf, moverOfPly, remainingAt, remainingSeries } from './gameTimes';
import { timedMoves } from './testMoves';

const tc = { initialMs: 180_000, incrementMs: 2_000 };
const moves = timedMoves(
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'],
  [{ remainingMs: 180_000 }, { remainingMs: 180_000 }, { remainingMs: 170_000 }, undefined, { remainingMs: 150_000 }],
);

describe('gameTimes', () => {
  it('hasClockData', () => {
    expect(hasClockData(moves)).toBe(true);
    expect(hasClockData(timedMoves(['e4'], []))).toBe(false);
    expect(hasClockData(timedMoves(['e4'], [{ spentMs: 1 }]))).toBe(true);
  });

  it('moverOfPly from white and black starts', () => {
    expect(moverOfPly(START_FEN, 1)).toBe('white');
    expect(moverOfPly(START_FEN, 2)).toBe('black');
    const b = '8/8/8/8/8/8/8/K1k5 b - - 0 1';
    expect(moverOfPly(b, 1)).toBe('black');
    expect(moverOfPly(b, 2)).toBe('white');
  });

  it('initialTimeOf: the time control, else the side’s first remaining time', () => {
    expect(initialTimeOf({ startFen: START_FEN, moves, timeControl: tc }, 'black')).toBe(180_000);
    const noTc = timedMoves(['e4', 'e5'], [{ remainingMs: 299_000 }, { remainingMs: 298_000 }]);
    expect(initialTimeOf({ startFen: START_FEN, moves: noTc }, 'black')).toBe(298_000);
    expect(initialTimeOf({ startFen: START_FEN, moves: timedMoves(['e4'], []) }, 'white')).toBeUndefined();
  });

  it('remainingAt: last value of the side ≤ ply, initial before its first move', () => {
    const g = { startFen: START_FEN, moves, timeControl: tc };
    expect(remainingAt(g, 0, 'white')).toBe(180_000);
    expect(remainingAt(g, 0, 'black')).toBe(180_000);
    expect(remainingAt(g, 3, 'white')).toBe(170_000);
    expect(remainingAt(g, 3, 'black')).toBe(180_000);
    // Ply 4 has no comment: Black keeps its previous value.
    expect(remainingAt(g, 4, 'black')).toBe(180_000);
    expect(remainingAt(g, 5, 'white')).toBe(150_000);
    expect(remainingAt(g, 99, 'white')).toBe(150_000);
  });

  it('remainingSeries per ply', () => {
    const s = remainingSeries({ startFen: START_FEN, moves, timeControl: tc });
    expect(s.white).toEqual([180_000, 180_000, 180_000, 170_000, 170_000, 150_000]);
    expect(s.black).toEqual([180_000, 180_000, 180_000, 180_000, 180_000, 180_000]);
  });
});
