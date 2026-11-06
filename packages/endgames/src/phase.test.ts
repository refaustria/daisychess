import { describe, expect, it } from 'vitest';
import { ENDGAME_MAX_PIECES, ENDGAME_MIN_PLIES, endgameStart, nonPawnPieces } from './phase.js';

/** A FEN with `n` non-pawn pieces (rooks/knights spread over ranks 1 and 8) plus pawns. */
function fenWith(n: number): string {
  const white = 'RNBQRNBR'.slice(0, Math.min(n, 8));
  const black = 'rnbqrnbr'.slice(0, Math.max(0, n - 8));
  const rank = (s: string) => (s.length === 8 ? s : s.length === 0 ? '8' : `${s}${8 - s.length}`);
  return `${rank(black)}/pppppppp/8/4k3/8/8/PPPPPPPP/${rank(white)} w - - 0 1`.replace(
    '8/4k3/8/8',
    '8/4k3/8/4K3',
  );
}

describe('nonPawnPieces', () => {
  it('counts queens, rooks, bishops and knights of both sides', () => {
    expect(nonPawnPieces('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe(14);
    expect(nonPawnPieces('8/8/8/4k3/8/8/4P3/4K3 w - - 0 1')).toBe(0);
    expect(nonPawnPieces(fenWith(5))).toBe(5);
    expect(nonPawnPieces(fenWith(11))).toBe(11);
  });
});

describe('endgameStart', () => {
  it('uses the thresholds of ADR-025 §5', () => {
    expect(ENDGAME_MAX_PIECES).toBe(6);
    expect(ENDGAME_MIN_PLIES).toBe(4);
  });

  it('starts at the first ply at or below 6 pieces', () => {
    const counts = [14, 12, 10, 8, 6, 6, 5, 4, 4];
    expect(endgameStart(counts.map(fenWith))).toBe(5);
  });

  it('starts after the last crossing when a late promotion goes above 6 again', () => {
    // ply:          1   2  3  4  5  6  7  8  9 10 11 12
    const counts = [14, 10, 7, 6, 6, 6, 6, 7, 6, 6, 6, 6];
    expect(endgameStart(counts.map(fenWith))).toBe(9);
  });

  it('is undefined with fewer than 4 endgame plies', () => {
    expect(endgameStart([14, 10, 7, 6, 6, 6].map(fenWith))).toBeUndefined();
    expect(endgameStart([14, 10, 7, 6, 6, 6, 6].map(fenWith))).toBe(4);
    // A promotion near the end leaves only 3 endgame plies.
    expect(endgameStart([10, 6, 6, 6, 6, 7, 6, 6, 6].map(fenWith))).toBeUndefined();
  });

  it('is undefined when the game does not end in an endgame, and for an empty game', () => {
    expect(endgameStart([14, 14, 13, 12].map(fenWith))).toBeUndefined();
    expect(endgameStart([])).toBeUndefined();
  });

  it('starts at ply 1 for a game that begins as an endgame', () => {
    expect(endgameStart([2, 2, 2, 2, 1].map(fenWith))).toBe(1);
  });
});
