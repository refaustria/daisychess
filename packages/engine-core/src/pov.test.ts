import { describe, expect, it } from 'vitest';
import { infoToWhitePov, scoreToWhitePov, sideToMove } from './index.js';

describe('sideToMove', () => {
  it('reads the second FEN field', () => {
    expect(sideToMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe('w');
    expect(sideToMove('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')).toBe('b');
  });
  it('defaults to white for malformed input', () => {
    expect(sideToMove('8/8/8/8/8/8/8/8')).toBe('w');
    expect(sideToMove('  8/8/8/8/8/8/8/8   b  ')).toBe('b');
  });
});

describe('scoreToWhitePov', () => {
  it('keeps scores with white to move', () => {
    expect(scoreToWhitePov({ cp: 35 }, 'w')).toEqual({ cp: 35 });
    expect(scoreToWhitePov({ mate: -2 }, 'w')).toEqual({ mate: -2 });
  });
  it('negates scores with black to move', () => {
    expect(scoreToWhitePov({ cp: 35 }, 'b')).toEqual({ cp: -35 });
    expect(scoreToWhitePov({ mate: 1 }, 'b')).toEqual({ mate: -1 });
    expect(scoreToWhitePov({ mate: -3 }, 'b')).toEqual({ mate: 3 });
  });
  it('never produces negative zero', () => {
    expect(Object.is((scoreToWhitePov({ cp: 0 }, 'b') as { cp: number }).cp, 0)).toBe(true);
    expect(Object.is((scoreToWhitePov({ mate: 0 }, 'b') as { mate: number }).mate, 0)).toBe(true);
  });
});

describe('infoToWhitePov', () => {
  const info = { depth: 10, multipv: 1, score: { cp: 20 }, pv: ['e7e5'], nps: 1000 };
  it('returns the same object with white to move', () => {
    expect(infoToWhitePov(info, 'w')).toBe(info);
  });
  it('copies and flips the score with black to move', () => {
    const out = infoToWhitePov(info, 'b');
    expect(out).toEqual({ ...info, score: { cp: -20 } });
    expect(info.score).toEqual({ cp: 20 });
  });
});
