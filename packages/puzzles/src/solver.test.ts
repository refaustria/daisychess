import { describe, expect, it } from 'vitest';
import {
  checkMove,
  initialSolution,
  normalizeUci,
  pendingMove,
  solutionState,
  userSide,
  type SolverState,
} from './solver.js';
import type { Puzzle } from './schemas.js';

const P: Puzzle = {
  id: '00008',
  fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
  moves: ['f2g3', 'e6e7', 'b2b1', 'b3c1', 'b1c1', 'h6c1'],
  rating: 1811,
  rd: 76,
  themes: ['crushing'],
  openings: [],
  source: 'lichess',
};
/** Back rank: after the intro, Ra8# and Rb8# both mate (solution: Ra8#). */
const MATE: Puzzle = {
  id: 'mate2',
  fen: '6k1/5ppp/8/4n3/8/8/8/RR4K1 b - - 0 1',
  moves: ['e5c4', 'a1a8'],
  themes: ['mateIn1'],
  openings: [],
  source: 'lichess',
};
const BACK_RANK = '6k1/5ppp/8/8/2n5/8/8/RR4K1 w - - 1 2';

describe('checkMove', () => {
  it('accepts the solution move', () => {
    expect(checkMove(BACK_RANK, 'a1a8', 'a1a8')).toBe('correct');
  });
  it('accepts another mate (alternative-mate rule)', () => {
    expect(checkMove(BACK_RANK, 'a1a8', 'b1b8')).toBe('mate');
  });
  it('rejects other legal moves and flags illegal ones', () => {
    expect(checkMove(BACK_RANK, 'a1a8', 'a1a7')).toBe('wrong');
    expect(checkMove(BACK_RANK, 'a1a8', 'a1h8')).toBe('illegal');
    expect(checkMove(BACK_RANK, 'a1a8', 'nonsense')).toBe('illegal');
    expect(checkMove('bad fen', 'a1a8', 'a1a8')).toBe('illegal');
  });
  it('compares promotions by full UCI; a mating underpromotion counts via the mate rule', () => {
    const fen = '8/P5k1/8/8/8/8/6K1/8 w - - 0 1';
    expect(checkMove(fen, 'a7a8q', 'a7a8q')).toBe('correct');
    expect(checkMove(fen, 'a7a8q', 'a7a8n')).toBe('wrong');
    expect(checkMove(fen, 'a7a8q', 'a7a8')).toBe('illegal');
    expect(checkMove(fen, 'a7a8q', 'A7A8Q')).toBe('correct');
    const mateFen = '7k/P5pp/8/8/8/8/8/6K1 w - - 0 1';
    expect(checkMove(mateFen, 'a7a8q', 'a7a8r')).toBe('mate');
  });
  it('reads a king move onto its own rook as castling', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    expect(checkMove(fen, 'e1g1', 'e1h1')).toBe('correct');
    expect(checkMove(fen, 'e1c1', 'e1a1')).toBe('correct');
    expect(normalizeUci(fen, 'e1h1')).toBe('e1g1');
    expect(normalizeUci(fen, 'e1e3')).toBeUndefined();
    expect(normalizeUci('bad', 'e1g1')).toBeUndefined();
  });
});

describe('userSide', () => {
  it('is the side to move after the intro, or in the FEN without one', () => {
    expect(userSide(P)).toBe('white');
    expect(userSide({ fen: BACK_RANK, noIntro: true })).toBe('white');
    expect(userSide({ fen: BACK_RANK })).toBe('black');
  });
});

const run = (
  s: SolverState | Puzzle,
  ...events: Parameters<typeof solutionState>[1][]
): SolverState =>
  events.reduce<SolverState>(
    (acc, e) => solutionState(acc, e),
    solutionState(s, { type: 'start' }),
  );

describe('solutionState', () => {
  it('starts in the intro and plays through a clean solve', () => {
    let s = solutionState(P, { type: 'start' });
    expect(s).toMatchObject({ phase: 'intro', ply: 0, userColor: 'white', fen: P.fen });
    expect(pendingMove(s)).toBe('f2g3');
    s = solutionState(s, { type: 'advance' });
    expect(s.phase).toBe('user');
    expect(pendingMove(s)).toBeUndefined();
    s = solutionState(s, { type: 'move', uci: 'e6e7' });
    expect(s.phase).toBe('opponent');
    expect(s.result).toBeUndefined();
    s = solutionState(s, { type: 'advance' });
    s = solutionState(s, { type: 'move', uci: 'b3c1' });
    s = solutionState(s, { type: 'advance' });
    s = solutionState(s, { type: 'move', uci: 'h6c1' });
    expect(s).toMatchObject({ phase: 'complete', outcome: 'solved', result: 'solved', ply: 6 });
    expect(s.played).toEqual(P.moves);
  });

  it('settles failed at the first wrong move; retry and later solve keep it failed', () => {
    let s = run(P, { type: 'advance' }, { type: 'move', uci: 'e6f6' });
    expect(s).toMatchObject({ phase: 'wrong', wrongMove: 'e6f6', result: 'failed', mistakes: 1 });
    const fenBefore = s.fen;
    expect(solutionState(s, { type: 'move', uci: 'e6e7' })).toBe(s); // must retry first
    s = solutionState(s, { type: 'retry' });
    expect(s.phase).toBe('user');
    expect(s.wrongMove).toBeUndefined();
    expect(s.fen).toBe(fenBefore);
    const finish = (from: SolverState): SolverState =>
      [
        { type: 'move', uci: 'e6e7' },
        { type: 'advance' },
        { type: 'move', uci: 'b3c1' },
        { type: 'advance' },
        { type: 'move', uci: 'h6c1' },
      ].reduce<SolverState>(
        (acc, e) => solutionState(acc, e as Parameters<typeof solutionState>[1]),
        from,
      );
    expect(finish(s)).toMatchObject({ phase: 'complete', outcome: 'solved', result: 'failed' });
    // a restart keeps the settled result too
    const again = solutionState(solutionState(s, { type: 'start' }), { type: 'advance' });
    expect(finish(again)).toMatchObject({
      phase: 'complete',
      outcome: 'solved',
      result: 'failed',
      mistakes: 0,
    });
  });

  it('ignores illegal moves and events of other phases', () => {
    const s = run(P, { type: 'advance' });
    expect(solutionState(s, { type: 'move', uci: 'a1a1' })).toBe(s);
    expect(solutionState(s, { type: 'advance' })).toBe(s);
    expect(solutionState(s, { type: 'retry' })).toBe(s);
    const intro = solutionState(P, { type: 'start' });
    expect(solutionState(intro, { type: 'move', uci: 'e6e7' })).toBe(intro);
    expect(solutionState(intro, { type: 'hint' })).toBe(intro);
  });

  it('hint highlights the piece and counts as a miss', () => {
    let s = run(P, { type: 'advance' }, { type: 'hint' });
    expect(s).toMatchObject({ phase: 'user', hint: 'e6', hints: 1, result: 'failed' });
    s = solutionState(s, { type: 'move', uci: 'e6e7' });
    expect(s.hint).toBeUndefined();
    // hint from the wrong phase returns to the user's turn
    const w = run(P, { type: 'advance' }, { type: 'move', uci: 'e6f6' }, { type: 'hint' });
    expect(w).toMatchObject({ phase: 'user', hint: 'e6' });
    expect(w.wrongMove).toBeUndefined();
  });

  it('show solution auto-plays the rest and settles failed', () => {
    let s = run(P, { type: 'advance' }, { type: 'showSolution' });
    expect(s).toMatchObject({ phase: 'showing', result: 'failed' });
    expect(solutionState(s, { type: 'showSolution' })).toBe(s);
    const moves: string[] = [];
    while (s.phase === 'showing') {
      moves.push(pendingMove(s)!);
      s = solutionState(s, { type: 'advance' });
    }
    expect(moves).toEqual(P.moves.slice(1));
    expect(s).toMatchObject({ phase: 'complete', outcome: 'shown', result: 'failed' });
    expect(solutionState(s, { type: 'showSolution' })).toBe(s);
    // from the intro: shows the intro too
    const fromIntro = solutionState(solutionState(P, { type: 'start' }), { type: 'showSolution' });
    expect(pendingMove(fromIntro)).toBe('f2g3');
  });

  it('solves at once on an alternative mate', () => {
    const s = run(MATE, { type: 'advance' }, { type: 'move', uci: 'b1b8' });
    expect(s).toMatchObject({ phase: 'complete', outcome: 'solved', result: 'solved' });
    expect(s.played).toEqual(['e5c4', 'b1b8']);
  });

  it('applies the alternative-mate rule at a non-final step', () => {
    // Solution: quiet Ra7 first (absurd but legal), the user mates at once instead.
    const long: Puzzle = { ...MATE, moves: ['e5c4', 'a1a7', 'c4d6', 'a7a8'] };
    const s = run(long, { type: 'advance' }, { type: 'move', uci: 'a1a8' });
    expect(s).toMatchObject({ phase: 'complete', result: 'solved' });
  });

  it('records the canonical castling move', () => {
    const castle: Puzzle = {
      id: 'c',
      fen: 'r3k2r/p7/8/8/8/8/8/R3K2R b KQkq - 0 1',
      moves: ['a7a6', 'e1g1'],
      themes: ['castling'],
      openings: [],
      source: 'lichess',
    };
    const s = run(castle, { type: 'advance' }, { type: 'move', uci: 'e1h1' });
    expect(s.played).toEqual(['a7a6', 'e1g1']);
    expect(s.phase).toBe('complete');
  });

  it('runs a puzzle without intro (mistake puzzle at ply 1)', () => {
    const p: Puzzle = {
      id: 'm:1',
      fen: BACK_RANK,
      moves: ['a1a8'],
      themes: [],
      openings: [],
      source: 'mistake',
      noIntro: true,
    };
    const s0 = initialSolution(p);
    expect(s0).toMatchObject({ phase: 'user', userColor: 'white' });
    expect(solutionState(s0, { type: 'move', uci: 'a1a8' })).toMatchObject({
      phase: 'complete',
      result: 'solved',
    });
  });

  it('accepts a puzzle given as the first argument for any event', () => {
    const s = solutionState(P, { type: 'advance' });
    expect(s.phase).toBe('user');
    expect(initialSolution(P, 'failed').result).toBe('failed');
  });

  it('completes when an opponent move ends the line', () => {
    const odd: Puzzle = { ...P, moves: ['f2g3', 'e6e7', 'b2b1'] };
    const s = run(odd, { type: 'advance' }, { type: 'move', uci: 'e6e7' }, { type: 'advance' });
    expect(s).toMatchObject({ phase: 'complete', outcome: 'solved', result: 'solved' });
  });
});
