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
