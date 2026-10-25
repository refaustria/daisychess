import { formatScore, type Score } from '@daisychess/engine-core';
import { Chess } from 'chess.js';
import type { Orientation } from '../store/gameStore';

/** A deviation at most this much worse than the engine's best move counts as fine (centipawns). */
export const FINE_THRESHOLD_CP = 30;
/** Evals are clamped to this before comparing: both "totally winning" lines are equal enough. */
export const CLAMP_CP = 1000;
const MATE_CP = 10_000;

/** Centipawns from White's point of view (mate in n = ±(10000 − n)). */
export function scoreToCp(score: Score): number {
  if ('cp' in score) return score.cp;
  const n = score.mate;
  if (n > 0) return MATE_CP - n;
  if (n < 0) return -MATE_CP - n;
  return 0;
}

/** White-POV score → the user's point of view. */
export const forSide = (cp: number, side: Orientation): number => (side === 'white' ? cp : -cp);

export interface DeviationVerdict {
  /** How much worse the played move is than the best move, for the user (cp, ≥ 0). */
  lossCp: number;
  fine: boolean;
}

/** Compares the played move's eval with the best move's (both White POV) for the mover `side`. */
export function judgeDeviation(best: Score, played: Score, side: Orientation): DeviationVerdict {
  const clamp = (cp: number) => Math.max(-CLAMP_CP, Math.min(CLAMP_CP, cp));
  const b = clamp(forSide(scoreToCp(best), side));
  const p = clamp(forSide(scoreToCp(played), side));
  const lossCp = Math.max(0, b - p);
  return { lossCp, fine: lossCp <= FINE_THRESHOLD_CP };
}

/** "+0.3" / "−1.2" / "M3" (White POV, as everywhere in the app). */
export const formatEval = (s: Score): string => formatScore(s);

/** Loss in pawns for the text, e.g. 312 → "3.1". */
export const formatLoss = (cp: number): string => (cp / 100).toFixed(1);

export interface ResolvedMove {
  san: string;
  from: string;
  to: string;
  promotion?: string;
  uci: string;
  fenAfter: string;
}

/** Resolves a SAN move in `fen`; null when illegal. */
export function resolveSan(fen: string, san: string): ResolvedMove | null {
  try {
    const m = new Chess(fen).move(san);
    return {
      san: m.san,
      from: m.from,
      to: m.to,
      ...(m.promotion ? { promotion: m.promotion } : {}),
      uci: `${m.from}${m.to}${m.promotion ?? ''}`,
      fenAfter: m.after,
    };
  } catch {
    return null;
  }
}

/** Mate/stalemate after a move (no search needed then). */
export function terminalScore(fen: string): Score | null {
  const c = new Chess(fen);
  if (c.isCheckmate()) {
    // The side to move is mated: White-POV mate score in favour of the other side.
    return c.turn() === 'w' ? { mate: -1 } : { mate: 1 };
  }
  if (c.isDraw() || c.isStalemate()) return { cp: 0 };
  return null;
}

export const sideToMove = (fen: string): Orientation =>
  fen.split(' ')[1] === 'b' ? 'black' : 'white';
