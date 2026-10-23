import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { START_FEN, type MoveRecord } from '../store/gameStore';
import { annotatePgn, evalComment } from './annotatePgn';
import { scholarSummary } from './testFixtures';

function scholarMoves(): MoveRecord[] {
  const c = new Chess();
  return ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'].map((san) => {
    const m = c.move(san);
    return { san: m.san, from: m.from, to: m.to, fen: c.fen() };
  });
}

describe('evalComment', () => {
  it('formats cp and mate', () => {
    expect(evalComment({ cp: 35 })).toBe('0.35');
    expect(evalComment({ cp: -120 })).toBe('-1.20');
    expect(evalComment({ mate: 3 })).toBe('#3');
    expect(evalComment({ mate: -3 })).toBe('#-3');
    expect(evalComment({ mate: 0 })).toBeUndefined();
  });
});

describe('annotatePgn', () => {
  const headers = { White: 'Ann', Black: 'Bob', Result: '1-0' };

  it('adds headers, accuracy, evals, NAGs and best-move comments', () => {
    const pgn = annotatePgn(headers, START_FEN, scholarMoves(), scholarSummary());
    expect(pgn).toContain('[White "Ann"]');
    expect(pgn).toContain('[Result "1-0"]');
    expect(pgn).toContain('{ Accuracy: White 87%, Black 62% }');
    expect(pgn).toContain('1. e4 { [%eval 0.30] } 1... e5 { [%eval 0.25] } 2. Bc4');
    expect(pgn).toContain('3. Qh5 $6 { [%eval 0.20] }');
    expect(pgn).toContain('3... Nf6 $4 { [%eval #1] best was g6 }');
    expect(pgn).toContain('4. Qxf7# 1-0');
    expect(pgn).not.toContain('$2');
  });

  it('is parseable by chess.js', () => {
    const pgn = annotatePgn(headers, START_FEN, scholarMoves(), scholarSummary());
    const c = new Chess();
    c.loadPgn(pgn);
    expect(c.history()).toHaveLength(7);
    expect(c.isCheckmate()).toBe(true);
  });

  it('falls back to plain movetext without a summary', () => {
    const pgn = annotatePgn({}, START_FEN, scholarMoves());
    expect(pgn).toBe('[Result "*"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# *\n');
  });

  it('adds SetUp/FEN for custom start positions and numbers from black', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const c = new Chess(fen);
    const m = c.move('e5');
    const pgn = annotatePgn({}, fen, [{ san: m.san, from: m.from, to: m.to, fen: c.fen() }]);
    expect(pgn).toContain(`[FEN "${fen}"]`);
    expect(pgn).toContain('[SetUp "1"]');
    expect(pgn).toContain('1... e5 *');
  });
});
