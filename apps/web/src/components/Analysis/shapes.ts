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

/** An extra arrow of a stop card's explanation; a repeated square (`e5e5`) is a circle. */
export interface ExtraArrow {
  uci: string;
  brush: string;
}

export interface ReviewShapeInput {
  previewing: boolean;
  /** Extra arrows of the tour's stop card (best green, played red, threat yellow). */
  extra?: readonly ExtraArrow[];
  /** UCI of the last stepped move of a previewed line; the only arrow while previewing. */
  lineArrow?: string | null;
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
  if (i.previewing) {
    const step = i.lineArrow ? uciArrow(i.lineArrow, 'blue') : null;
    return step ? [step] : [];
  }
  const base: DrawShape[] = [];
  if (i.move) {
    const { playedUci, bestUci, classification } = i.move;
    const same = bestUci === playedUci;
    const played = uciArrow(playedUci, same ? 'green' : CLASS_BRUSH[classification]);
    const best = bestUci && !same ? uciArrow(bestUci, 'green') : null;
    for (const s of [played, best]) if (s) base.push(s);
  }
  const extra = (i.extra ?? []).map(extraShape).filter((s): s is DrawShape => s !== null);
  const seen = new Set<string>();
  return [...base, ...extra].filter((s) => {
    const key = `${s.orig}${s.dest ?? ''}${s.brush ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Arrow, or a circle (no `dest`) when the move repeats its square. */
function extraShape(a: ExtraArrow): DrawShape | null {
  const s = uciArrow(a.uci, a.brush);
  if (s && s.orig === s.dest) return { orig: s.orig, brush: a.brush };
  return s;
}
