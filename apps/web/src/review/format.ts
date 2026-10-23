import type { MoveClass, ReviewedMove } from '@chesslab/engine-core';
import { convertPv } from '../engine/pvToSan';
import type { MoveRecord } from '../store/gameStore';

export interface ClassInfo {
  label: string;
  /** Annotation symbol appended to the SAN (empty = none). */
  glyph: string;
  /** CSS colour (tokens with fallbacks). */
  color: string;
}

export const CLASS_INFO: Record<MoveClass, ClassInfo> = {
  best: { label: 'Best', glyph: '✓', color: 'var(--success)' },
  excellent: { label: 'Excellent', glyph: '', color: 'var(--success)' },
  good: { label: 'Good', glyph: '', color: 'var(--accent)' },
  inaccuracy: { label: 'Inaccuracy', glyph: '?!', color: 'var(--warning, #d9a406)' },
  mistake: { label: 'Mistake', glyph: '?', color: 'var(--mistake, #ea7a0c)' },
  blunder: { label: 'Blunder', glyph: '??', color: 'var(--danger)' },
  forced: { label: 'Forced', glyph: '', color: 'var(--text-muted)' },
};

/** Win probability for White (0..100) before/after the reviewed move. */
export function whiteProbs(m: ReviewedMove): { before: number; after: number } {
  return m.mover === 'white'
    ? { before: m.winProbBefore, after: m.winProbAfter }
    : { before: 100 - m.winProbBefore, after: 100 - m.winProbAfter };
}

/** `12.` / `12...` prefix for a 1-based ply of a game starting at `startFen`. */
export function moveNumberLabel(startFen: string, ply: number): string {
  const parts = startFen.split(' ');
  const startBlack = parts[1] === 'b';
  const startNum = Number(parts[5]) || 1;
  const idx = ply - 1 + (startBlack ? 1 : 0);
  return `${startNum + Math.floor(idx / 2)}${idx % 2 === 1 ? '...' : '.'}`;
}

/** SAN of the engine's best move in the position before `move.ply`, if it differs from the played one. */
export function bestMoveSan(
  startFen: string,
  moves: readonly MoveRecord[],
  move: ReviewedMove,
): string | undefined {
  if (!move.bestMove || move.bestMove === move.uci) return undefined;
  const fen = move.ply <= 1 ? startFen : moves[move.ply - 2]?.fen;
  if (!fen) return undefined;
  return convertPv(fen, [move.bestMove]).san[0];
}
