import type { EngineInfo, Score } from './types.js';

/** Side to move from a FEN string (second field). Anything other than `b` is treated as White. */
export function sideToMove(fen: string): 'w' | 'b' {
  return fen.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w';
}

const negate = (n: number): number => (n === 0 ? 0 : -n);

/**
 * Convert a UCI score (always relative to the side to move) to White's perspective.
 * With Black to move, `cp`/`mate` are negated; with White to move the score is returned unchanged.
 */
export function scoreToWhitePov(score: Score, toMove: 'w' | 'b'): Score {
  if (toMove === 'w') return score;
  return 'cp' in score ? { cp: negate(score.cp) } : { mate: negate(score.mate) };
}

/** `info` with its score converted to White's perspective (see {@link scoreToWhitePov}). */
export function infoToWhitePov(info: EngineInfo, toMove: 'w' | 'b'): EngineInfo {
  return toMove === 'w' ? info : { ...info, score: scoreToWhitePov(info.score, toMove) };
}
