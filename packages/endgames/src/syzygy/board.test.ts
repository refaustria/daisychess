import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { TbBoard, TbBoardError, isCaptureMove, isEnPassantMove } from './board.js';

/** Deterministic PRNG (mulberry32), as in scripts/make-tb-fixtures.mjs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random legal FENs of a material (chess.js validates; the side not to move is not in check). */
function randomFens(material: string, n: number, seed: number): string[] {
  const r = rng(seed);
  const out: string[] = [];
  const [w = '', b = ''] = material.split('v');
  while (out.length < n) {
    const board: string[] = new Array<string>(64).fill('');
    const letters = [...w.toUpperCase(), ...b.toLowerCase()];
    let ok = true;
    for (const l of letters) {
      let placed = false;
      for (let t = 0; t < 50 && !placed; t++) {
        const s = Math.floor(r() * 64);
        if (board[s] || (l.toLowerCase() === 'p' && (s < 8 || s >= 56))) continue;
        board[s] = l;
        placed = true;
      }
      ok &&= placed;
    }
    if (!ok) continue;
    const rows: string[] = [];
    for (let rank = 7; rank >= 0; rank--) {
      let row = '';
      let e = 0;
      for (let f = 0; f < 8; f++) {
        const p = board[rank * 8 + f];
        if (!p) e++;
        else {
          if (e) row += String(e);
          e = 0;
          row += p;
        }
      }
      if (e) row += String(e);
      rows.push(row);
    }
    const fen = `${rows.join('/')} ${r() < 0.5 ? 'w' : 'b'} - - 0 1`;
    try {
      TbBoard.fromFen(fen);
      new Chess(fen);
      out.push(fen);
    } catch {
      // illegal (the side not to move in check, …): draw again
    }
  }
  return out;
}

const chessJsMoves = (fen: string): string[] =>
  new Chess(fen)
    .moves({ verbose: true })
    .map((m) => m.lan)
    .sort();

const ourMoves = (b: TbBoard): string[] => b.legalMoves().map(TbBoard.uci).sort();

describe('TbBoard', () => {
  it('generates exactly the legal moves of chess.js (random positions, two plies deep)', () => {
    let positions = 0;
    for (const [material, seed] of [
      ['KRPvKR', 1],
      ['KQvKP', 2],
      ['KPvKP', 3],
      ['KQRvKBN', 4],
      ['KPPvKPP', 5],
      ['KBNvK', 6],
    ] as const) {
      for (const fen of randomFens(material, 40, seed)) {
        const b = TbBoard.fromFen(fen);
        expect(ourMoves(b), fen).toEqual(chessJsMoves(fen));
        positions++;
        // Every child (FEN from chess.js, which tracks en passant itself) agrees as well.
        const chess = new Chess(fen);
        for (const m of chess.moves({ verbose: true }).slice(0, 6)) {
          expect(ourMoves(TbBoard.fromFen(m.after)), m.after).toEqual(chessJsMoves(m.after));
          positions++;
        }
      }
    }
    expect(positions).toBeGreaterThan(600);
  }, 60_000);

  it('push/pop restores the position, the clocks and en passant', () => {
    for (const fen of randomFens('KPPvKPP', 30, 9)) {
      const b = TbBoard.fromFen(fen);
      const before = { sq: [...b.sq], turn: b.turn, ep: b.ep, half: b.halfmove };
      for (const m of b.legalMoves()) {
        b.push(m);
        for (const m2 of b.legalMoves()) {
          b.push(m2);
          b.pop();
        }
        b.pop();
      }
      expect({ sq: [...b.sq], turn: b.turn, ep: b.ep, half: b.halfmove }).toEqual(before);
    }
  });

  it('handles en passant: generation, legality (pinned pawn) and the captured pawn', () => {
    const b = TbBoard.fromFen('8/8/8/3pP3/8/8/8/K6k w - d6 0 1');
    const ep = b.legalMoves().filter(isEnPassantMove);
    expect(ep.map(TbBoard.uci)).toEqual(['e5d6']);
    expect(isCaptureMove(ep[0]!)).toBe(true);
    b.push(ep[0]!);
    expect(b.sq[35]).toBe(0); // d5 emptied
    expect(b.halfmove).toBe(0);
    b.pop();
    expect(b.sq[35]).not.toBe(0);
    // The en passant capture would expose the king on the fifth rank: illegal.
    const pinned = TbBoard.fromFen('8/8/8/K2pP2r/8/8/8/7k w - d6 0 1');
    expect(pinned.legalMoves().filter(isEnPassantMove)).toEqual([]);
    expect(ourMoves(pinned)).toEqual(chessJsMoves('8/8/8/K2pP2r/8/8/8/7k w - d6 0 1'));
    // A double step sets the en passant square, any other move clears it.
    const d = TbBoard.fromFen('4k3/8/8/8/5p2/8/4P3/4K3 w - - 0 1');
    const double = d.legalMoves().find((m) => TbBoard.uci(m) === 'e2e4')!;
    d.push(double);
    expect(d.ep).toBe(20); // e3
    expect(ourMoves(d)).toContain('f4e3');
  });

  it('counts the halfmove clock and recognises zeroing moves', () => {
    const b = TbBoard.fromFen('4k3/8/8/8/8/8/4P3/R3K3 w - - 7 30');
    const rook = b.legalMoves().find((m) => TbBoard.uci(m) === 'a1a2')!;
    const pawn = b.legalMoves().find((m) => TbBoard.uci(m) === 'e2e3')!;
    expect(b.isZeroing(rook)).toBe(false);
    expect(b.isZeroing(pawn)).toBe(true);
    b.push(rook);
    expect(b.halfmove).toBe(8);
    b.pop();
    b.push(pawn);
    expect(b.halfmove).toBe(0);
  });

  it('computes material keys and piece lists like python-chess', () => {
    const b = TbBoard.fromFen('1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1');
    expect(b.key()).toBe('KRPvKR');
    expect(b.key(true)).toBe('KRvKRP');
    expect(b.squares(4, 0)).toEqual([2]); // white rook c1
    expect(b.pieceCount()).toBe(5);
    expect(b.onlyKings()).toBe(false);
    expect(TbBoard.fromFen('8/8/8/8/8/8/8/K6k w - - 0 1').onlyKings()).toBe(true);
  });

  it('rejects positions the tablebases do not contain', () => {
    for (const fen of [
      'r3k3/8/8/8/8/8/8/4K3 b q - 0 1', // castling rights
      '8/8/8/8/8/8/8/K7 w - - 0 1', // one king
      'P3k3/8/8/8/8/8/8/4K3 w - - 0 1', // pawn on the last rank
      '4k2R/8/8/8/8/8/8/4K3 w - - 0 1', // the side not to move is in check
      '4k3/8/8/8/8/8/8 w - - 0 1', // seven ranks
      '4k3/8/8/8/8/8/8/4K3 x - - 0 1',
      '4k3/8/8/8/8/8/8/4K3 w - e9 0 1',
    ]) {
      expect(() => TbBoard.fromFen(fen), fen).toThrow(TbBoardError);
    }
    // An en passant square without a double-stepped pawn is ignored, like chess.js does.
    expect(TbBoard.fromFen('4k3/8/8/8/8/8/8/4K3 b - e3 0 1').ep).toBe(-1);
  });

  it('detects check, mate and stalemate', () => {
    const mate = TbBoard.fromFen('k7/1Q6/1K6/8/8/8/8/8 b - - 0 1');
    expect(mate.isCheck()).toBe(true);
    expect(mate.legalMoves()).toEqual([]);
    const stale = TbBoard.fromFen('k7/2Q5/1K6/8/8/8/8/8 b - - 0 1');
    expect(stale.isCheck()).toBe(false);
    expect(stale.legalMoves()).toEqual([]);
  });

  it('writes UCI with the promotion piece', () => {
    const b = TbBoard.fromFen('8/1P6/8/8/8/8/8/K6k w - - 0 1');
    expect(ourMoves(b)).toEqual(['a1a2', 'a1b1', 'a1b2', 'b7b8b', 'b7b8n', 'b7b8q', 'b7b8r']);
  });
});
