import { beforeEach, describe, expect, it } from 'vitest';
import {
  START_FEN,
  currentFen,
  gameStatus,
  isCheck,
  isPromotionMove,
  lastMove,
  legalDests,
  turn,
  useGameStore,
} from './gameStore';

const st = () => useGameStore.getState();

beforeEach(() => st().reset());

describe('helpers', () => {
  it('start position', () => {
    expect(currentFen(st())).toBe(START_FEN);
    expect(turn(st())).toBe('white');
    expect(lastMove(st())).toBeUndefined();
    expect(isCheck(st())).toBe(false);
    expect(gameStatus(st())).toBe('playing');
    const d = legalDests(st());
    expect(d.get('e2')).toEqual(expect.arrayContaining(['e3', 'e4']));
    expect(d.get('g1')?.sort()).toEqual(['f3', 'h3']);
    expect(d.has('e1')).toBe(false);
  });

  it('turn, lastMove after a move', () => {
    st().makeMove('e2', 'e4');
    expect(turn(st())).toBe('black');
    expect(lastMove(st())).toEqual(['e2', 'e4']);
  });

  it('detects check', () => {
    for (const [f, t] of [
      ['e2', 'e4'],
      ['f7', 'f6'],
      ['d1', 'h5'],
    ] as const)
      st().makeMove(f, t);
    st().makeMove('g7', 'g6');
    st().makeMove('h5', 'g6');
    expect(isCheck(st())).toBe(true);
  });

  it("fool's mate is checkmate", () => {
    for (const [f, t] of [
      ['f2', 'f3'],
      ['e7', 'e5'],
      ['g2', 'g4'],
      ['d8', 'h4'],
    ] as const) {
      expect(st().makeMove(f, t)).toBe(true);
    }
    expect(gameStatus(st())).toBe('checkmate');
    expect(isCheck(st())).toBe(true);
    expect(legalDests(st()).size).toBe(0);
  });

  it('stalemate and draw', () => {
    st().loadFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(gameStatus(st())).toBe('stalemate');
    st().loadFen('8/8/4k3/8/8/4K3/8/8 w - - 0 1');
    expect(gameStatus(st())).toBe('draw');
  });
});

describe('actions', () => {
  it('rejects illegal moves', () => {
    expect(st().makeMove('e2', 'e5')).toBe(false);
    expect(st().makeMove('e7', 'e5')).toBe(false);
    expect(st().moves).toHaveLength(0);
    expect(st().ply).toBe(0);
  });

  it('undo', () => {
    st().makeMove('e2', 'e4');
    st().makeMove('e7', 'e5');
    st().undo();
    expect(st().moves).toHaveLength(1);
    expect(st().ply).toBe(1);
    st().undo();
    st().undo();
    expect(currentFen(st())).toBe(START_FEN);
  });

  it('navigation', () => {
    st().makeMove('e2', 'e4');
    st().makeMove('e7', 'e5');
    st().makeMove('g1', 'f3');
    st().first();
    expect(st().ply).toBe(0);
    st().prev();
    expect(st().ply).toBe(0);
    st().next();
    expect(st().ply).toBe(1);
    st().goTo(2);
    expect(currentFen(st())).toBe(st().moves[1]?.fen);
    st().last();
    expect(st().ply).toBe(3);
    st().next();
    expect(st().ply).toBe(3);
    st().goTo(99);
    expect(st().ply).toBe(3);
  });

  it('truncates the future when branching', () => {
    st().makeMove('e2', 'e4');
    st().makeMove('e7', 'e5');
    st().makeMove('g1', 'f3');
    st().goTo(1);
    st().makeMove('c7', 'c5');
    expect(st().moves.map((m) => m.san)).toEqual(['e4', 'c5']);
    expect(st().ply).toBe(2);
  });

  it('flip', () => {
    st().flip();
    expect(st().orientation).toBe('black');
    st().flip();
    expect(st().orientation).toBe('white');
  });

  it('loadFen valid/invalid', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    expect(st().loadFen(fen)).toBe(true);
    expect(st().startFen).toBe(fen);
    expect(currentFen(st())).toBe(fen);
    expect(st().loadFen('garbage')).toBe(false);
    expect(st().startFen).toBe(fen);
  });

  it('loadPgn', () => {
    const pgn = '[Event "Test"]\n[White "A"]\n[Black "B"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1/2-1/2';
    expect(st().loadPgn(pgn)).toBe(true);
    expect(st().moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
    expect(st().ply).toBe(6);
    expect(st().headers.White).toBe('A');
    expect(st().startFen).toBe(START_FEN);
    expect(st().loadPgn('1. e4 e5 2. Ke4')).toBe(false);
  });

  it('promotion defaults to queen, explicit piece honoured', () => {
    st().loadFen('8/P6k/8/8/8/8/7K/8 w - - 0 1');
    st().makeMove('a7', 'a8');
    expect(st().moves[0]?.promotion).toBe('q');
    expect(st().moves[0]?.san.startsWith('a8=Q')).toBe(true);
    st().loadFen('8/P6k/8/8/8/8/7K/8 w - - 0 1');
    st().makeMove('a7', 'a8', 'n');
    expect(st().moves[0]?.promotion).toBe('n');
  });

  it('isPromotionMove: only legal pawn moves to the last rank', () => {
    st().loadFen('1n5k/P7/8/8/8/8/8/K7 w - - 0 1');
    expect(isPromotionMove(st(), 'a7', 'a8')).toBe(true);
    expect(isPromotionMove(st(), 'a7', 'b8')).toBe(true);
    expect(isPromotionMove(st(), 'a1', 'a2')).toBe(false);
    st().loadFen('n6k/P7/8/8/8/8/8/K7 w - - 0 1');
    expect(isPromotionMove(st(), 'a7', 'a8')).toBe(false); // blocked
  });
});

describe('loadPgn clock data (M22-1)', () => {
  const PGN =
    '[TimeControl "180+2"]\n\n1. e4 { [%clk 0:03:00] } 1... e5 { [%clk 0:03:00] } 2. Nf3 { [%clk 0:02:50] } 2... Nc6 *';

  it('sets per-move clocks and the time control', () => {
    expect(st().loadPgn(PGN)).toBe(true);
    const s = st();
    expect(s.timeControl).toEqual({ initialMs: 180_000, incrementMs: 2_000 });
    expect(s.moves.map((m) => m.clock)).toEqual([
      { remainingMs: 180_000, spentMs: 0 },
      { remainingMs: 180_000, spentMs: 0 },
      { remainingMs: 170_000, spentMs: 12_000 },
      undefined,
    ]);
    expect('clock' in s.moves[3]!).toBe(false);
  });

  it('moves made on the board have no clock; reset and loadFen clear the time control', () => {
    st().loadPgn(PGN);
    st().goTo(3);
    expect(st().makeMove('f8', 'c5')).toBe(true);
    expect(st().moves[3]?.clock).toBeUndefined();
    expect(st().moves[2]?.clock).toEqual({ remainingMs: 170_000, spentMs: 12_000 });
    st().reset();
    expect(st().timeControl).toBeUndefined();
    st().loadPgn(PGN);
    st().loadFen('8/8/8/8/8/8/8/K1k5 w - - 0 1');
    expect(st().timeControl).toBeUndefined();
  });

  it('a PGN without clock data leaves the moves unchanged', () => {
    st().loadPgn('1. e4 e5 *');
    expect(st().moves.every((m) => m.clock === undefined)).toBe(true);
    expect(st().timeControl).toBeUndefined();
  });
});
