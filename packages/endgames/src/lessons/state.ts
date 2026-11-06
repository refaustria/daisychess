import { Chess, type Move } from 'chess.js';
import { bestMove, judgeMove, keepers, moverResult, pieceCount } from '../tablebase/judge.js';
import type { TbPosition, TbVerdict } from '../tablebase/types.js';
import type { Lesson } from './schema.js';

/**
 * - `intro`: the lesson text is shown, nothing is played yet (`start`);
 * - `user`: the user is to move;
 * - `app`: waiting for the app to play the opponent's reply (`reply`);
 * - `done`: the lesson is over (see `outcome` and `reason`).
 */
export type LessonPhase = 'intro' | 'user' | 'app' | 'done';

export type LessonFailure =
  /** The user's move worsened the tablebase result (win → draw/loss, draw → loss). */
  | 'thrown'
  /** Win lesson: the user's move budget is used up without mate. */
  | 'budget'
  /** Win lesson: the game ended drawn. */
  | 'stalemate'
  | 'insufficient'
  | 'fiftyMoves'
  | 'repetition'
  /** The opponent checkmated the user. */
  | 'mated';

export type LessonSuccess =
  /** The user checkmated. */
  | 'mate'
  /** Draw lesson: the user held for `budget` opponent moves. */
  | 'held'
  /** Draw lesson: a tablebase draw with ≤ 3 pieces. */
  | 'tablebaseDraw'
  /** Draw lesson: the game ended drawn. */
  | 'stalemate'
  | 'insufficient'
  | 'fiftyMoves'
  | 'repetition';

export interface LessonState {
  lesson: Lesson;
  phase: LessonPhase;
  /** Position on the board. */
  fen: string;
  /** Positions since the start: `fens[0]` = lesson start, `fens[i + 1]` = after `played[i]`. */
  fens: string[];
  /** Moves on the board since the start (canonical UCI). */
  played: string[];
  userMoves: number;
  opponentMoves: number;
  outcome?: 'success' | 'failure';
  reason?: LessonFailure | LessonSuccess;
  /** Verdict of the user's last move when a tablebase position was supplied with it. */
  verdict?: TbVerdict;
  /** Plan sentences shown so far (`lesson.hints.slice(0, hintIndex)`). */
  hintIndex: number;
  /** From-square of the best keeper after a hint (cleared by the next move). */
  hintSquare?: string;
  /** Best keeper (UCI) after "Show move" (cleared by the next move). */
  shownMove?: string;
  /** Hints and shown moves (each counts as a mistake for the progress record). */
  hints: number;
  /** Take-backs. */
  mistakes: number;
  /** 1 for the first try, +1 per restart. */
  attempts: number;
}

export type LessonEvent =
  /** Leave the intro (or restart from scratch keeping the counters). */
  | { type: 'start' }
  /**
   * The user's move (UCI). `tb` is the tablebase position **before** the move (the current
   * position); without it the move is not judged. Illegal moves and moves outside `user` are
   * ignored.
   */
  | { type: 'move'; uci: string; tb?: TbPosition | null }
  /** The opponent's reply (UCI); `tb` optionally the position **after** it. */
  | { type: 'reply'; uci: string; tb?: TbPosition | null }
  /** Next plan sentence; `tb` (current position) to highlight the best keeper's piece. */
  | { type: 'hint'; tb?: TbPosition | null }
  /** Show the best keeper as an arrow; needs `tb` (current position). */
  | { type: 'showMove'; tb: TbPosition | null }
  /** Back to the position before the user's last move (counts as a mistake). */
  | { type: 'takeBack' }
  /** Back to the start position (a new attempt; counters kept). */
  | { type: 'restart' };

const isState = (x: Lesson | LessonState): x is LessonState => 'phase' in x && 'lesson' in x;

const sideToMove = (fen: string): 'white' | 'black' =>
  fen.trim().split(/\s+/)[1] === 'b' ? 'black' : 'white';

/** Position identity for repetitions and tablebase matching (placement, side, castling, ep). */
const posKey = (fen: string): string => fen.trim().split(/\s+/).slice(0, 4).join(' ');

/** Initial state of a lesson (phase `intro`). */
export function initialLesson(lesson: Lesson): LessonState {
  return {
    lesson,
    phase: 'intro',
    fen: lesson.fen,
    fens: [lesson.fen],
    played: [],
    userMoves: 0,
    opponentMoves: 0,
    hintIndex: 0,
    hints: 0,
    mistakes: 0,
    attempts: 1,
  };
}

function findMove(fen: string, uci: string): { move: Move; chess: Chess } | undefined {
  const text = uci.trim().toLowerCase();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(text)) return undefined;
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return undefined;
  }
  const move = chess.moves({ verbose: true }).find((m) => m.lan === text);
  if (!move) return undefined;
  chess.move(move.lan);
  return { move, chess };
}

/** A drawn game end on the board after a move, or undefined. */
function drawReason(
  chess: Chess,
  fens: string[],
): 'stalemate' | 'insufficient' | 'fiftyMoves' | 'repetition' | undefined {
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isInsufficientMaterial()) return 'insufficient';
  if (chess.isDrawByFiftyMoves()) return 'fiftyMoves';
  const key = posKey(chess.fen());
  if (fens.filter((f) => posKey(f) === key).length >= 3) return 'repetition';
  return undefined;
}

function clearMarks(s: LessonState): LessonState {
  const next = { ...s };
  delete next.hintSquare;
  delete next.shownMove;
  return next;
}

function finish(
  s: LessonState,
  outcome: 'success' | 'failure',
  reason: LessonFailure | LessonSuccess,
): LessonState {
  return { ...s, phase: 'done', outcome, reason };
}

const tbFor = (s: LessonState, tb: TbPosition | null | undefined): TbPosition | undefined =>
  tb && posKey(tb.fen) === posKey(s.fen) ? tb : undefined;

function phaseFor(s: LessonState, fen: string): 'user' | 'app' {
  return sideToMove(fen) === s.lesson.userSide ? 'user' : 'app';
}

/** Rewinds to `fens[index]` (moves after it dropped), recounting the moves of both sides. */
function rewind(s: LessonState, index: number): LessonState {
  const fens = s.fens.slice(0, index + 1);
  const fen = fens[index]!;
  let userMoves = 0;
  for (let i = 0; i < index; i++) if (sideToMove(fens[i]!) === s.lesson.userSide) userMoves++;
  const next: LessonState = {
    ...clearMarks(s),
    fen,
    fens,
    played: s.played.slice(0, index),
    userMoves,
    opponentMoves: index - userMoves,
    phase: phaseFor(s, fen),
  };
  delete next.outcome;
  delete next.reason;
  delete next.verdict;
  return next;
}

/**
 * The lesson state machine (pure reducer, mirrors `solutionState` of @daisychess/puzzles).
 * `current` is a state, or a lesson (= its initial state). Events that do not apply return the
 * state unchanged (same object). Tablebase data comes in with the events; the reducer never
 * probes.
 */
export function lessonState(current: Lesson | LessonState, event: LessonEvent): LessonState {
  const s = isState(current) ? current : initialLesson(current);
  const { lesson } = s;
  switch (event.type) {
    case 'start': {
      if (s.phase !== 'intro') return s;
      return { ...s, phase: phaseFor(s, s.fen) };
    }
    case 'restart': {
      if (s.phase === 'intro') return s;
      const next = rewind(s, 0);
      return { ...next, attempts: s.attempts + 1, hintIndex: 0 };
    }
    case 'takeBack': {
      if (s.phase !== 'user' && !(s.phase === 'done' && s.outcome === 'failure')) return s;
      // Index of the user's last move.
      let idx = -1;
      for (let i = s.played.length - 1; i >= 0; i--) {
        if (sideToMove(s.fens[i]!) === lesson.userSide) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return s;
      return { ...rewind(s, idx), mistakes: s.mistakes + 1 };
    }
    case 'hint': {
      if (s.phase !== 'user') return s;
      const next: LessonState = {
        ...s,
        hintIndex: Math.min(s.hintIndex + 1, lesson.hints.length),
        hints: s.hints + 1,
      };
      const tb = tbFor(s, event.tb);
      const best = tb ? keepers(tb)[0] : undefined;
      if (best) next.hintSquare = best.uci.slice(0, 2);
      return next;
    }
    case 'showMove': {
      if (s.phase !== 'user') return s;
      const tb = tbFor(s, event.tb);
      const best = tb ? bestMove(tb) : undefined;
      if (!best) return s;
      return { ...s, shownMove: best.uci, hints: s.hints + 1 };
    }
    case 'move': {
      if (s.phase !== 'user') return s;
      const found = findMove(s.fen, event.uci);
      if (!found) return s;
      const { move, chess } = found;
      const tb = tbFor(s, event.tb);
      const verdict = tb ? judgeMove(tb, move.lan) : undefined;
      const fen = chess.fen();
      const fens = [...s.fens, fen];
      let next: LessonState = {
        ...clearMarks(s),
        fen,
        fens,
        played: [...s.played, move.lan],
        userMoves: s.userMoves + 1,
      };
      if (verdict) next.verdict = verdict;
      else delete next.verdict;
      if (verdict?.kind === 'thrown') return finish(next, 'failure', 'thrown');
      if (chess.isCheckmate()) return finish(next, 'success', 'mate');
      const draw = drawReason(chess, fens);
      if (draw) return finish(next, lesson.goal === 'draw' ? 'success' : 'failure', draw);
      if (lesson.goal === 'draw' && verdict?.after === 'draw' && pieceCount(fen) <= 3)
        return finish(next, 'success', 'tablebaseDraw');
      if (lesson.goal === 'win' && next.userMoves >= lesson.budget)
        return finish(next, 'failure', 'budget');
      next = { ...next, phase: 'app' };
      return next;
    }
    case 'reply': {
      if (s.phase !== 'app') return s;
      const found = findMove(s.fen, event.uci);
      if (!found) return s;
      const { move, chess } = found;
      const fen = chess.fen();
      const fens = [...s.fens, fen];
      const next: LessonState = {
        ...clearMarks(s),
        fen,
        fens,
        played: [...s.played, move.lan],
        opponentMoves: s.opponentMoves + 1,
      };
      if (chess.isCheckmate()) return finish(next, 'failure', 'mated');
      const draw = drawReason(chess, fens);
      if (draw) return finish(next, lesson.goal === 'draw' ? 'success' : 'failure', draw);
      if (lesson.goal === 'draw') {
        const tb = tbFor(next, event.tb);
        if (tb && moverResult(tb.category) === 'draw' && pieceCount(fen) <= 3)
          return finish(next, 'success', 'tablebaseDraw');
        if (next.opponentMoves >= lesson.budget) return finish(next, 'success', 'held');
      }
      return { ...next, phase: phaseFor(next, fen) };
    }
  }
}

/** Moves left in the budget: user moves (win) or opponent moves to hold out (draw). */
export function budgetLeft(state: LessonState): number {
  const used = state.lesson.goal === 'win' ? state.userMoves : state.opponentMoves;
  return Math.max(0, state.lesson.budget - used);
}

/** The plan sentences revealed so far. */
export function shownHints(state: LessonState): string[] {
  return state.lesson.hints.slice(0, state.hintIndex);
}
