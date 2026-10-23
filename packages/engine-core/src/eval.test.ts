import { describe, expect, it } from 'vitest';
import { cpToWinProbability, evalBarShare, formatScore, scoreToWinProbability } from './index.js';

describe('cpToWinProbability', () => {
  it('is 50 at 0', () => expect(cpToWinProbability(0)).toBe(50));
  it('approaches 100 / 0', () => {
    expect(cpToWinProbability(2000)).toBeGreaterThan(99.9);
    expect(cpToWinProbability(-2000)).toBeLessThan(0.1);
  });
  it('is symmetric', () => {
    expect(cpToWinProbability(150) + cpToWinProbability(-150)).toBeCloseTo(100, 10);
  });
  it('matches known value for +100cp (~59.1)', () => {
    expect(cpToWinProbability(100)).toBeCloseTo(59.1, 1);
  });
});

describe('scoreToWinProbability', () => {
  it('handles cp', () => expect(scoreToWinProbability({ cp: 0 })).toBe(50));
  it('mate for white is 100, for black 0', () => {
    expect(scoreToWinProbability({ mate: 3 })).toBe(100);
    expect(scoreToWinProbability({ mate: -3 })).toBe(0);
  });
  it('mate 0 is treated as a loss', () => expect(scoreToWinProbability({ mate: 0 })).toBe(0));
  it('inverts for black pov', () => {
    expect(scoreToWinProbability({ mate: 2 }, false)).toBe(0);
    expect(scoreToWinProbability({ cp: 0 }, false)).toBe(50);
    expect(scoreToWinProbability({ cp: 100 }, false)).toBeCloseTo(
      100 - cpToWinProbability(100),
      10,
    );
  });
});

describe('evalBarShare', () => {
  it('clamps to [2, 98]', () => {
    expect(evalBarShare({ mate: 1 })).toBe(98);
    expect(evalBarShare({ mate: -1 })).toBe(2);
    expect(evalBarShare({ cp: 5000 })).toBe(98);
    expect(evalBarShare({ cp: -5000 })).toBe(2);
  });
  it('passes through mid values', () => expect(evalBarShare({ cp: 0 })).toBe(50));
});

describe('formatScore', () => {
  it('formats cp', () => {
    expect(formatScore({ cp: 35 })).toBe('+0.35');
    expect(formatScore({ cp: -170 })).toBe('-1.70');
    expect(formatScore({ cp: 0 })).toBe('0.00');
    expect(formatScore({ cp: 0.4 })).toBe('0.00');
  });
  it('formats mate', () => {
    expect(formatScore({ mate: 4 })).toBe('M4');
    expect(formatScore({ mate: -3 })).toBe('-M3');
  });
});
