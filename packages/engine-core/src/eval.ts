import type { Score } from './types.js';

/**
 * Lichess win-probability sigmoid. Returns 0..100, the chance for White given `cp`
 * (centipawns from White's perspective).
 */
export function cpToWinProbability(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/**
 * Win probability 0..100 for the given score.
 * Scores are interpreted from White's perspective when `povWhite` is true (default);
 * with `povWhite = false` the score is from Black's perspective and the result is
 * still the probability for White.
 * Mate: positive mate => 100, negative => 0. `mate: 0` means the side to move is
 * checkmated; its sign is ambiguous, so it is treated as a loss for the score's
 * owner (i.e. 0 for the pov side).
 */
export function scoreToWinProbability(score: Score, povWhite = true): number {
  let p: number;
  if ('mate' in score) {
    p = score.mate > 0 ? 100 : 0;
  } else {
    p = cpToWinProbability(score.cp);
  }
  return povWhite ? p : 100 - p;
}

/** White's share of the eval bar (0..100), clamped to [2, 98] so neither side vanishes. */
export function evalBarShare(score: Score): number {
  return Math.min(98, Math.max(2, scoreToWinProbability(score)));
}

/** Format from White's perspective: `+0.35`, `-1.70`, `0.00`, `M4`, `-M3`. */
export function formatScore(score: Score): string {
  if ('mate' in score) {
    return score.mate < 0 ? `-M${-score.mate}` : `M${score.mate}`;
  }
  const v = score.cp / 100;
  const s = Math.abs(v).toFixed(2);
  if (s === '0.00') return '0.00';
  return `${v > 0 ? '+' : '-'}${s}`;
}
