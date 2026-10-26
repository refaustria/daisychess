import { Chess, type Move } from 'chess.js';
import type { Puzzle, Side } from './schemas.js';

/**
 * Verdict on one user move (ADR-023 §6): the expected solution move → `correct`; another move
 * that checkmates → `mate` (lichess's alternative-mate rule, the puzzle is solved at once);
 * any other legal move → `wrong`; a move that is not legal in `fen` → `illegal` (not counted).
 */
export type MoveVerdict = 'correct' | 'mate' | 'wrong' | 'illegal';

const sideOf = (fen: string): Side => (fen.split(' ')[1] === 'b' ? 'black' : 'white');

/**
 * The legal move `uci` names in `chess`, or undefined. Promotions compare the full UCI
 * (`e7e8q`; a missing promotion piece is not a move). A king move onto its own rook (how some
 * boards express castling, `e1h1`) is read as the castling move.
 */
function findMove(chess: Chess, uci: string): Move | undefined {
  const text = uci.trim().toLowerCase();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(text)) return undefined;
  const legal = chess.moves({ verbose: true });
  const exact = legal.find((m) => m.lan === text);
  if (exact) return exact;
  const from = text.slice(0, 2);
  const to = text.slice(2, 4);
  const piece = chess.get(from as Move['from']);
  const target = chess.get(to as Move['to']);
  if (piece?.type === 'k' && target?.type === 'r' && target.color === piece.color) {
    const flag = to[0]! > from[0]! ? 'k' : 'q';
    return legal.find((m) => m.piece === 'k' && m.from === from && m.flags.includes(flag));
  }
  return undefined;
}

/** Canonical UCI of `uci` in `fen` (castling as king two squares), or undefined if illegal. */
export function normalizeUci(fen: string, uci: string): string | undefined {
  try {
    return findMove(new Chess(fen), uci)?.lan;
  } catch {
    return undefined;
  }
}

/** Judges the user's move `playedUci` in `fen` against the solution move `expectedUci`. */
export function checkMove(fen: string, expectedUci: string, playedUci: string): MoveVerdict {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return 'illegal';
  }
  const move = findMove(chess, playedUci);
  if (!move) return 'illegal';
  if (move.lan === expectedUci.trim().toLowerCase()) return 'correct';
  chess.move(move.lan);
  return chess.isCheckmate() ? 'mate' : 'wrong';
}

/** Side the user plays: the side to move after the intro move (or in `fen` without intro). */
export function userSide(puzzle: Pick<Puzzle, 'fen' | 'noIntro'>): Side {
  const toMove = sideOf(puzzle.fen);
  if (puzzle.noIntro) return toMove;
  return toMove === 'white' ? 'black' : 'white';
}

/**
 * - `intro`: waiting for the app to play the opponent's first move (`advance`);
 * - `user`: the user is to move;
 * - `opponent`: waiting for the app to play the opponent's reply (`advance`);
 * - `wrong`: the last user move was wrong (shown with an arrow, then taken back; `retry`);
 * - `showing`: "Show solution" auto-plays the rest (`advance` per move);
 * - `complete`: the line is over (see `outcome`).
 */
export type SolverPhase = 'intro' | 'user' | 'opponent' | 'wrong' | 'showing' | 'complete';

export interface SolverState {
  puzzle: Puzzle;
  phase: SolverPhase;
  /** Index into `puzzle.moves` of the next move to play. */
  ply: number;
  /** Position on the board. */
  fen: string;
  /** Moves played on the board so far (UCI; an alternative mate appears as played). */
  played: string[];
  userColor: Side;
  /**
   * Rating outcome, settled at the first terminal event and never changed afterwards: the first
   * wrong move, hint or "Show solution" → `failed`; reaching the end without any → `solved`.
   */
  result?: 'solved' | 'failed';
  /** How the line ended (phase `complete`): played out by the user, or shown. */
  outcome?: 'solved' | 'shown';
  /** The wrong move to show (phase `wrong`). */
  wrongMove?: string;
  /** From-square of the expected move after a hint (cleared by the next move). */
  hint?: string;
  mistakes: number;
  hints: number;
}

export type SolverEvent =
  /** (Re)start the puzzle from its position; a settled `result` is kept (retries are free). */
  | { type: 'start' }
  /** The app plays the scheduled move (intro, opponent reply, or a move of the shown solution). */
  | { type: 'advance' }
  /** The user's move (UCI). Illegal moves are ignored. */
  | { type: 'move'; uci: string }
  /** Take the wrong move back and let the user try again. */
  | { type: 'retry' }
  /** Highlight the piece to move (counts as a miss). */
  | { type: 'hint' }
  /** Auto-play the rest (counts as a miss). */
  | { type: 'showSolution' };

const isState = (x: Puzzle | SolverState): x is SolverState => 'phase' in x && 'puzzle' in x;

/** Initial state of a puzzle (before the intro move). */
export function initialSolution(puzzle: Puzzle, result?: SolverState['result']): SolverState {
  const state: SolverState = {
    puzzle,
    phase: puzzle.noIntro ? 'user' : 'intro',
    ply: 0,
    fen: puzzle.fen,
    played: [],
    userColor: userSide(puzzle),
    mistakes: 0,
    hints: 0,
  };
  if (result) state.result = result;
  return state;
}

function play(fen: string, uci: string): string {
  const chess = new Chess(fen);
  chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return chess.fen();
}

function complete(s: SolverState, outcome: 'solved' | 'shown'): SolverState {
  const next: SolverState = { ...s, phase: 'complete', outcome };
  delete next.hint;
  delete next.wrongMove;
  if (!next.result) next.result = outcome === 'solved' ? 'solved' : 'failed';
  return next;
}

/**
 * The puzzle state machine (pure reducer). `current` is a state, or a puzzle (= its initial
 * state, so `solutionState(puzzle, { type: 'start' })` starts it). Events that do not apply to
 * the current phase return the state unchanged (same object).
 */
export function solutionState(current: Puzzle | SolverState, event: SolverEvent): SolverState {
  const s = isState(current) ? current : initialSolution(current);
  const { moves } = s.puzzle;
  switch (event.type) {
    case 'start':
      return initialSolution(s.puzzle, s.result);
    case 'advance': {
      if (s.phase !== 'intro' && s.phase !== 'opponent' && s.phase !== 'showing') return s;
      const uci = moves[s.ply];
      if (uci === undefined) return complete(s, s.phase === 'showing' ? 'shown' : 'solved');
      const next: SolverState = {
        ...s,
        fen: play(s.fen, uci),
        ply: s.ply + 1,
        played: [...s.played, uci],
      };
      delete next.hint;
      delete next.wrongMove;
      if (next.ply >= moves.length)
        return complete(next, s.phase === 'showing' ? 'shown' : 'solved');
      return s.phase === 'showing' ? next : { ...next, phase: 'user' };
    }
    case 'move': {
      if (s.phase !== 'user') return s;
      const expected = moves[s.ply];
      if (expected === undefined) return s;
      const verdict = checkMove(s.fen, expected, event.uci);
      if (verdict === 'illegal') return s;
      if (verdict === 'wrong') {
        const next: SolverState = {
          ...s,
          phase: 'wrong',
          wrongMove: normalizeUci(s.fen, event.uci) ?? event.uci,
          mistakes: s.mistakes + 1,
          result: s.result ?? 'failed',
        };
        delete next.hint;
        return next;
      }
      const uci = verdict === 'correct' ? expected : normalizeUci(s.fen, event.uci)!;
      const next: SolverState = {
        ...s,
        fen: play(s.fen, uci),
        ply: s.ply + 1,
        played: [...s.played, uci],
      };
      delete next.hint;
      if (verdict === 'mate' || next.ply >= moves.length) return complete(next, 'solved');
      return { ...next, phase: 'opponent' };
    }
    case 'retry': {
      if (s.phase !== 'wrong') return s;
      const next: SolverState = { ...s, phase: 'user' };
      delete next.wrongMove;
      return next;
    }
    case 'hint': {
      if (s.phase !== 'user' && s.phase !== 'wrong') return s;
      const expected = moves[s.ply];
      if (expected === undefined) return s;
      const next: SolverState = {
        ...s,
        phase: 'user',
        hint: expected.slice(0, 2),
        hints: s.hints + 1,
        result: s.result ?? 'failed',
      };
      delete next.wrongMove;
      return next;
    }
    case 'showSolution': {
      if (s.phase === 'complete' || s.phase === 'showing') return s;
      const next: SolverState = { ...s, phase: 'showing', result: s.result ?? 'failed' };
      delete next.wrongMove;
      delete next.hint;
      return next;
    }
  }
}

/** The move the app should play now (phases `intro`, `opponent`, `showing`), else undefined. */
export function pendingMove(state: SolverState): string | undefined {
  if (state.phase !== 'intro' && state.phase !== 'opponent' && state.phase !== 'showing')
    return undefined;
  return state.puzzle.moves[state.ply];
}
