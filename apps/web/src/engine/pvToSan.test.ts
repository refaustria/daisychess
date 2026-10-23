import { describe, expect, it } from 'vitest';
import { convertPv, pvToSan } from './pvToSan';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('pvToSan', () => {
  it('numbers White and Black moves', () => {
    expect(pvToSan(START, ['e2e4', 'e7e5', 'g1f3'])).toBe('1. e4 e5 2. Nf3');
  });
  it('uses ellipsis when Black moves first', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 2 12';
    expect(pvToSan(fen, ['c6d4', 'f3d4', 'e5d4'])).toBe('12... Nd4 13. Nxd4 exd4');
    expect(pvToSan(fen, ['b8c6'])).toBe('');
  });
  it('converts promotion', () => {
    expect(pvToSan('8/4P2k/8/8/8/8/8/4K3 w - - 0 1', ['e7e8q'])).toBe('1. e8=Q');
  });
  it('converts castling', () => {
    const fen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 5';
    expect(pvToSan(fen, ['e1g1', 'e8c8'])).toBe('5. O-O O-O-O');
  });
  it('truncates at the first illegal move', () => {
    const c = convertPv(START, ['e2e4', 'e2e4', 'g8f6']);
    expect(c.san).toEqual(['e4']);
    expect(c.count).toBe(1);
    expect(pvToSan(START, ['zzzz'])).toBe('');
    expect(pvToSan('garbage', ['e2e4'])).toBe('');
  });
  it('returns the final fen and is memoised', () => {
    const a = convertPv(START, ['e2e4']);
    expect(a.fen).toContain('4P3');
    expect(convertPv(START, ['e2e4'])).toBe(a);
  });
});
