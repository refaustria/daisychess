import type { MoveClass } from '@daisychess/engine-core';
import type { DrawShape } from 'chessground/draw';
import type { Key } from 'chessground/types';

const isSquare = (s: string): boolean => /^[a-h][1-8]$/.test(s);

/** Arrow for a UCI move, or null if malformed. */
export function uciArrow(uci: string, brush: string): DrawShape | null {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  if (!isSquare(from) || !isSquare(to)) return null;
  return { orig: from as Key, dest: to as Key, brush };
}

export interface ShapeInput {
  enabled: boolean;
  terminal: boolean;
  previewing: boolean;
  /** Analysis lines belong to the displayed game position. */
  inSync: boolean;
  best?: string;
  hover: string[] | null;
}

/** Arrows for the board: hovered line (up to 3 moves) or else the green best-move arrow. */
export function analysisShapes(i: ShapeInput): DrawShape[] {
  if (!i.enabled || i.terminal || i.previewing || !i.inSync) return [];
  const pick = i.hover && i.hover.length > 0 ? i.hover.slice(0, 3) : null;
  if (pick) {
    return pick
      .map((m, n) => uciArrow(m, n === 0 ? 'blue' : 'paleBlue'))
      .filter((s): s is DrawShape => s !== null);
  }
  const arrow = i.best ? uciArrow(i.best, 'green') : null;
  return arrow ? [arrow] : [];
}

/** Arrow brush of a played move by its review class (chessground's `yellow` is orange). */
export const CLASS_BRUSH: Record<MoveClass, string> = {
  best: 'green',
  excellent: 'paleGreen',
  good: 'paleGreen',
  forced: 'paleGreen',
  inaccuracy: 'yellow',
  mistake: 'red',
  blunder: 'red',
};

export interface ReviewShapeInput {
  previewing: boolean;
  /** Review data of the move that led to the displayed position, if any. */
  move?: {
    playedUci: string;
    bestUci?: string;
    classification: MoveClass;
  };
}

/**
 * Review arrows for the displayed ply: the played move coloured by its class and, when it differs,
 * the engine's best move in green (from the position before the move).
 */
export function reviewShapes(i: ReviewShapeInput): DrawShape[] {
  if (i.previewing || !i.move) return [];
  const { playedUci, bestUci, classification } = i.move;
  const same = bestUci === playedUci;
  const played = uciArrow(playedUci, same ? 'green' : CLASS_BRUSH[classification]);
  const best = bestUci && !same ? uciArrow(bestUci, 'green') : null;
  return [played, best].filter((s): s is DrawShape => s !== null);
}
