import { scoreToWinProbability } from './eval.js';
import { sideToMove } from './pov.js';
import type { Score } from './types.js';

/** Classification of a played move. `forced` = the only legal move. */
export type MoveClass =
  | 'best'
  | 'excellent'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder'
  | 'forced';

/** All classes in display order. */
export const MOVE_CLASSES: readonly MoveClass[] = [
  'best',
  'excellent',
  'good',
  'inaccuracy',
  'mistake',
  'blunder',
  'forced',
];

/**
 * Win-probability-loss thresholds (percentage points, mover's perspective).
 * `best`: loss < 0.5 (or the engine's best move); the others are inclusive upper
 * bounds: excellent <= 2, good <= 5, inaccuracy <= 10, mistake <= 20; anything above
 * `mistake` is a blunder.
 */
export const CLASSIFICATION_THRESHOLDS = {
  best: 0.5,
  excellent: 2,
  good: 5,
  inaccuracy: 10,
  mistake: 20,
} as const;

/** One reviewed move. Win probabilities are 0..100 from the mover's perspective. */
export interface ReviewedMove {
  ply: number;
  san?: string;
  uci: string;
  mover: 'white' | 'black';
  /** Position eval before the move (White POV). */
  evalBefore: Score;
  /** Position eval after the move (White POV). */
  evalAfter: Score;
  bestMove?: string;
  winProbBefore: number;
  winProbAfter: number;
  /** Win probability lost by the move, 0..100 (0 if the move gained). */
  winProbLoss: number;
  classification: MoveClass;
}

export interface SideSummary {
  accuracy: number;
  counts: Record<MoveClass, number>;
}

export interface ReviewSummary {
  white: SideSummary;
  black: SideSummary;
  moves: ReviewedMove[];
}

/**
 * Win probability 0..100 for `mover` given a White-POV score of the position
 * reached after (`afterMove = true`) or before the mover's move. `mate: 0` after a
 * move means the mover delivered checkmate, so it counts as a win for the mover.
 */
function moverWinProb(score: Score, mover: 'white' | 'black', afterMove: boolean): number {
  if (afterMove && 'mate' in score && score.mate === 0) return 100;
  const white = scoreToWinProbability(score);
  return mover === 'white' ? white : 100 - white;
}

function lossOf(
  evalBefore: Score,
  evalAfter: Score,
  mover: 'white' | 'black',
): { before: number; after: number; loss: number } {
  const before = moverWinProb(evalBefore, mover, false);
  const after = moverWinProb(evalAfter, mover, true);
  return { before, after, loss: Math.max(0, before - after) };
}

/**
 * Classify a move by the win probability it loses from the mover's perspective.
 * Evals are White POV. Mates are 100/0 win probability, so keeping a mate or being
 * mated sooner loses nothing, while throwing away a mate loses (100 - p).
 */
export function classifyMove(input: {
  evalBefore: Score;
  evalAfter: Score;
  mover: 'white' | 'black';
  playedIsBest: boolean;
  legalMoves?: number;
}): MoveClass {
  if (input.legalMoves === 1) return 'forced';
  if (input.playedIsBest) return 'best';
  const { loss } = lossOf(input.evalBefore, input.evalAfter, input.mover);
  return classifyLoss(loss);
}

function classifyLoss(loss: number): MoveClass {
  const t = CLASSIFICATION_THRESHOLDS;
  if (loss < t.best) return 'best';
  if (loss <= t.excellent) return 'excellent';
  if (loss <= t.good) return 'good';
  if (loss <= t.inaccuracy) return 'inaccuracy';
  if (loss <= t.mistake) return 'mistake';
  return 'blunder';
}

/**
 * Per-move accuracy 0..100 (Lichess formula). Both arguments are win probabilities
 * (0..100) from the mover's perspective; a move that gained counts as zero loss.
 */
export function moveAccuracy(winProbBefore: number, winProbAfter: number): number {
  const loss = Math.max(0, winProbBefore - winProbAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * loss) - 3.1669;
  return Math.min(100, Math.max(0, acc));
}

/**
 * Game accuracy for one side: arithmetic mean rounded to 1 decimal (0 for no moves).
 * TODO: Lichess blends a volatility-weighted mean with the harmonic mean.
 */
export function gameAccuracy(accuracies: number[]): number {
  if (accuracies.length === 0) return 0;
  const mean = accuracies.reduce((a, b) => a + b, 0) / accuracies.length;
  return Math.round(mean * 10) / 10;
}

function emptyCounts(): Record<MoveClass, number> {
  return { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, forced: 0 };
}

/**
 * Review a whole game. `positions[i]` is the position before `moves[i]` (eval in White
 * POV, optional engine best move); `positions[moves.length]` is the final position.
 * @throws Error when `positions.length !== moves.length + 1`.
 */
export function reviewGame(input: {
  positions: Array<{ fen: string; eval: Score; bestMove?: string }>;
  moves: Array<{ uci: string; san?: string; legalMoves?: number }>;
}): ReviewSummary {
  const { positions, moves } = input;
  if (positions.length !== moves.length + 1) {
    throw new Error(
      `reviewGame: expected positions.length === moves.length + 1, got ${positions.length} positions and ${moves.length} moves`,
    );
  }
  const reviewed: ReviewedMove[] = [];
  const acc: Record<'white' | 'black', number[]> = { white: [], black: [] };
  const counts = { white: emptyCounts(), black: emptyCounts() };

  moves.forEach((m, i) => {
    const pos = positions[i]!;
    const next = positions[i + 1]!;
    const mover = sideToMove(pos.fen) === 'w' ? 'white' : 'black';
    const playedIsBest = pos.bestMove !== undefined && m.uci === pos.bestMove;
    const { before, after, loss } = lossOf(pos.eval, next.eval, mover);
    const classification = classifyMove({
      evalBefore: pos.eval,
      evalAfter: next.eval,
      mover,
      playedIsBest,
      legalMoves: m.legalMoves,
    });
    reviewed.push({
      ply: i + 1,
      ...(m.san !== undefined ? { san: m.san } : {}),
      uci: m.uci,
      mover,
      evalBefore: pos.eval,
      evalAfter: next.eval,
      ...(pos.bestMove !== undefined ? { bestMove: pos.bestMove } : {}),
      winProbBefore: before,
      winProbAfter: after,
      winProbLoss: loss,
      classification,
    });
    acc[mover].push(moveAccuracy(before, after));
    counts[mover][classification]++;
  });

  return {
    white: { accuracy: gameAccuracy(acc.white), counts: counts.white },
    black: { accuracy: gameAccuracy(acc.black), counts: counts.black },
    moves: reviewed,
  };
}
