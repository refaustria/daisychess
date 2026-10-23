import { describe, expect, it } from 'vitest';
import { PIECE_VALUES, material } from './material';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('material', () => {
  it('uses the requested values', () => {
    expect(PIECE_VALUES).toEqual({ p: 1, n: 3, b: 3, r: 5, q: 7 });
  });

  it('start position: nothing captured, no advantage', () => {
    const m = material(START, START);
    expect(m.advantage).toBe(0);
    expect(Object.values(m.lost.white).every((n) => n === 0)).toBe(true);
    expect(Object.values(m.lost.black).every((n) => n === 0)).toBe(true);
  });

  it('after 1.e4 d5 2.exd5: black lost a pawn, white is +1', () => {
    const m = material(START, 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2');
    expect(m.lost.black.p).toBe(1);
    expect(m.lost.white.p).toBe(0);
    expect(m.advantage).toBe(1);
  });

  it('black ahead gives a negative advantage', () => {
    const m = material(START, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1');
    expect(m.lost.white.q).toBe(1);
    expect(m.advantage).toBe(-7);
  });

  it('promotion: counts clamp at 0, advantage uses the pieces on the board', () => {
    // White promoted a pawn to a second queen; black lost nothing of those types.
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/1PPPPPPP/QNBQKBNR w KQkq - 0 1';
    const m = material(START, fen);
    expect(m.lost.white.r).toBe(1);
    expect(m.lost.white.q).toBe(0);
    expect(m.lost.black.p).toBe(0);
    expect(m.lost.white.p).toBe(1);
    // white: 7 pawns + 2 queens + 2 bishops + 2 knights + 1 rook = 38; black: 37
    expect(m.advantage).toBe(1);
  });

  it('custom start position uses its own start counts', () => {
    const start = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
    const m = material(start, '4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    expect(m.lost.white.p).toBe(1);
    expect(m.lost.white.q).toBe(0);
    expect(m.advantage).toBe(0);
  });
});
