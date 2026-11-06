import { describe, expect, it } from 'vitest';
import fixture from '../../test/fixtures/lichess-krpvkr-win.json';
import {
  TABLEBASE_MAX_PIECES,
  bestMove,
  judgeMove,
  keepers,
  moverResult,
  pieceCount,
  rankMoves,
  tablebaseEligible,
  tbScoreHint,
} from './judge.js';
import { normalizeLichess } from './lichess.js';
import type { TbCategory, TbMove, TbPosition } from './types.js';

const FEN = '1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1';

function fixturePos(edit?: (moves: Array<{ uci: string; category: string }>) => void): TbPosition {
  const json = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
  edit?.(json.moves);
  const pos = normalizeLichess(json, FEN);
  if (!pos) throw new Error('fixture did not normalise');
  return pos;
}

const mv = (uci: string, category: TbCategory, extra: Partial<TbMove> = {}): TbMove => ({
  uci,
  san: uci,
  category,
  zeroing: false,
  checkmate: false,
  stalemate: false,
  ...extra,
});

describe('moverResult', () => {
  it('folds the 50-move variants into draws', () => {
    expect(moverResult('win')).toBe('win');
    expect(moverResult('loss')).toBe('loss');
    expect(moverResult('draw')).toBe('draw');
    expect(moverResult('cursed-win')).toBe('draw');
    expect(moverResult('blessed-loss')).toBe('draw');
  });
});

describe('judgeMove on the real lichess answer', () => {
  it('Rd1+ keeps the win (Black is lost after it); keepers best first', () => {
    const pos = fixturePos();
    const v = judgeMove(pos, 'c1d1')!;
    expect(v).toMatchObject({
      uci: 'c1d1',
      san: 'Rd1+',
      before: 'win',
      after: 'win',
      kind: 'kept',
      dtmBefore: 41,
      dtzBefore: 15,
    });
    expect(v.keepers).toHaveLength(11);
    expect(v.keepers.slice(0, 2)).toEqual(['c1c4', 'c1d1']); // DTM 40, then UCI
    expect(v.keepers).not.toContain('c1a1');
    expect(v.keepers).not.toContain('c1c6');
    expect(v.keepers).not.toContain('c1c2');
    const byUci = new Map(pos.moves.map((m) => [m.uci, m]));
    const dtms = v.keepers.map((u) => Math.abs(byUci.get(u)!.dtm!));
    expect(dtms).toEqual([...dtms].sort((a, b) => a - b));
  });

  it('only when Rd1+ is the single keeper', () => {
    const pos = fixturePos((moves) => {
      for (const m of moves) if (m.uci !== 'c1d1' && m.category === 'loss') m.category = 'draw';
    });
    const v = judgeMove(pos, 'c1d1')!;
    expect(v.kind).toBe('only');
    expect(v.keepers).toEqual(['c1d1']);
  });

  it('thrown when Rd1+ leads to a draw; win → loss is thrown as well', () => {
    const pos = fixturePos((moves) => {
      moves.find((m) => m.uci === 'c1d1')!.category = 'draw';
    });
    const v = judgeMove(pos, 'c1d1')!;
    expect(v).toMatchObject({ kind: 'thrown', before: 'win', after: 'draw' });
    expect(v.keepers).not.toContain('c1d1');
    expect(v.keepers[0]).toBe('c1c4');
    expect(judgeMove(fixturePos(), 'c1c2')).toMatchObject({ kind: 'thrown', after: 'loss' });
  });

  it('a blessed loss for the opponent is a thrown win (draw by the 50-move rule)', () => {
    const pos = fixturePos((moves) => {
      moves.find((m) => m.uci === 'c1d1')!.category = 'blessed-loss';
    });
    expect(judgeMove(pos, 'c1d1')).toMatchObject({ kind: 'thrown', after: 'draw' });
  });

  it('is undefined for a move the position does not list; accepts upper case', () => {
    expect(judgeMove(fixturePos(), 'b8a8')).toBeUndefined();
    expect(judgeMove(fixturePos(), 'C1D1')?.uci).toBe('c1d1');
  });

  it('draw → loss is thrown, draw → draw is kept', () => {
    const pos: TbPosition = {
      fen: FEN,
      category: 'draw',
      moves: [mv('a1a2', 'draw'), mv('a1a3', 'win'), mv('a1a4', 'draw')],
    };
    expect(judgeMove(pos, 'a1a3')).toMatchObject({ kind: 'thrown', before: 'draw', after: 'loss' });
    expect(judgeMove(pos, 'a1a2')).toMatchObject({ kind: 'kept', keepers: ['a1a2', 'a1a4'] });
    expect(judgeMove(pos, 'a1a2')!.dtmBefore).toBeUndefined();
  });
});

describe('rankMoves', () => {
  it('orders fastest win, then draws with zeroing first, then slowest loss', () => {
    const pos: TbPosition = {
      fen: FEN,
      category: 'win',
      moves: [
        mv('a1a8', 'win', { dtz: 5 }), // loss for the mover, fast
        mv('a1a7', 'win', { dtz: 30 }), // loss for the mover, slow
        mv('a1a6', 'draw'),
        mv('a1a5', 'draw', { zeroing: true }),
        mv('a1a4', 'loss', { dtz: -9, dtm: -21 }),
        mv('a1a3', 'loss', { dtz: -3, dtm: -25 }),
        mv('a1a2', 'loss', { dtz: -1, dtm: -1, checkmate: false }),
        mv('a1b1', 'loss', { dtz: 0, dtm: 0, checkmate: true }),
        mv('a1c1', 'blessed-loss', { dtz: -101 }),
        mv('a1d1', 'cursed-win', { dtz: 102 }),
      ],
    };
    expect(rankMoves(pos).map((m) => m.uci)).toEqual([
      'a1b1', // checkmate
      'a1a2', // DTM 1
      'a1a4', // DTM 21
      'a1a3', // DTM 25 (DTZ ignored when DTM is known)
      'a1c1', // cursed win
      'a1a5', // zeroing draw
      'a1a6',
      'a1d1', // blessed loss
      'a1a7', // slowest loss
      'a1a8',
    ]);
  });

  it('falls back to DTZ without DTM and breaks ties by UCI; does not mutate', () => {
    const moves = [
      mv('h1h2', 'loss', { dtz: -7 }),
      mv('b1b2', 'loss', { dtz: -7 }),
      mv('c1c2', 'loss', { dtz: -3 }),
    ];
    const pos: TbPosition = { fen: FEN, category: 'win', moves };
    expect(rankMoves(pos).map((m) => m.uci)).toEqual(['c1c2', 'b1b2', 'h1h2']);
    expect(moves[0]!.uci).toBe('h1h2');
  });

  it('bestMove and keepers follow the ranking', () => {
    const pos = fixturePos();
    expect(bestMove(pos)?.uci).toBe('c1c4');
    expect(keepers(pos).map((m) => m.uci)).toEqual(judgeMove(pos, 'c1d1')!.keepers);
    expect(bestMove({ fen: FEN, category: 'loss', moves: [] })).toBeUndefined();
    expect(keepers({ fen: FEN, category: 'loss', moves: [mv('a1a2', 'win')] })).toHaveLength(1);
  });
});

describe('tbScoreHint', () => {
  it('reports White wins with mate in N moves', () => {
    expect(tbScoreHint(fixturePos())).toEqual({
      result: 'white',
      dtm: 41,
      dtz: 15,
      mateIn: 21,
      exact50: true,
    });
  });

  it('turns the side to move into White/Black', () => {
    const pos: TbPosition = {
      fen: '8/8/8/8/8/8/8/K1k5 b - - 0 1',
      category: 'win',
      moves: [],
      dtz: 3,
    };
    expect(tbScoreHint(pos)).toEqual({ result: 'black', dtz: 3, exact50: true });
    expect(tbScoreHint({ ...pos, category: 'loss' }).result).toBe('white');
  });

  it('a cursed win folds to a draw with exact50: false', () => {
    const pos: TbPosition = { fen: FEN, category: 'cursed-win', dtz: 103, dtm: 120, moves: [] };
    const hint = tbScoreHint(pos);
    expect(hint).toMatchObject({ result: 'draw', exact50: false, dtm: 120 });
    expect(hint.mateIn).toBeUndefined();
    expect(tbScoreHint({ ...pos, category: 'blessed-loss' }).exact50).toBe(false);
    expect(tbScoreHint({ ...pos, category: 'draw' }).exact50).toBe(true);
  });
});

describe('pieceCount / tablebaseEligible', () => {
  it('counts every piece including kings', () => {
    expect(pieceCount(FEN)).toBe(5);
    expect(pieceCount('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe(32);
  });

  it('accepts legal positions with ≤ 7 pieces and no castling rights', () => {
    expect(TABLEBASE_MAX_PIECES).toBe(7);
    expect(tablebaseEligible(FEN)).toBe(true);
    expect(tablebaseEligible('8/5p2/8/4k3/r7/8/4PP2/R3K3 w - - 0 1')).toBe(true); // 7
    expect(tablebaseEligible('8/5pp1/8/4k3/r7/8/4PP2/R3K3 w - - 0 1')).toBe(false); // 8
    expect(tablebaseEligible('r3k3/8/8/8/8/8/8/R3K3 w Qq - 0 1')).toBe(false);
    expect(tablebaseEligible('r3k3/8/8/8/8/8/8/R3K3 w - - 0 1')).toBe(true);
    expect(tablebaseEligible('8/8/8/8/8/8/8/8 w - - 0 1')).toBe(false); // no kings
    expect(tablebaseEligible('not a fen')).toBe(false);
  });
});
