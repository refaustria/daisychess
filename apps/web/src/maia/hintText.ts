/**
 * Wording of the Maia review hints (M23-3): one or two short lines per mistake for the move card,
 * a short suffix for the guided tour and the per-player "typical mistakes" counts of the summary.
 */
import type { MoveClass, ReviewSummary } from '@daisychess/engine-core';
import { CLASS_INFO } from '../review/format';
import type { MaiaHint, MaiaLevel } from './hints';

/** Below this probability the engine's move counts as "hard to find" for humans. */
export const HARD_TO_FIND_P = 0.05;
/** A played move below this probability made in time trouble counts as a slip. */
export const UNUSUAL_P = 0.1;

/** `41%`; `<1%` for anything that rounds to 0. */
export function pct(p: number): string {
  const v = Math.round(p * 100);
  return v < 1 ? '<1%' : `${v}%`;
}

/** `1500`, or `1900 (Maia's highest level)` for a clamped rating. */
export function levelText(level: Pick<MaiaLevel, 'rating' | 'note'>): string {
  return level.note ? `${level.rating} (${level.note})` : String(level.rating);
}

/** Where the level comes from, for a tooltip: `Maia 1500 — from the PGN rating 1523`. */
export function levelSource(level: MaiaLevel): string {
  const from =
    level.source === 'pgn' && level.elo !== undefined
      ? `from the PGN rating ${level.elo}`
      : 'your level setting (no rating in the PGN)';
  return `Maia ${level.rating}${level.note ? ` (${level.note})` : ''} — ${from}`;
}

const CLASS_WORD: Partial<Record<MoveClass, string>> = {
  inaccuracy: 'inaccuracy',
  mistake: 'mistake',
  blunder: 'blunder',
};

export interface HintMoveInfo {
  playedSan: string;
  /** Stockfish's best move (SAN), only when it differs from the played move. */
  bestSan?: string;
  classification: MoveClass;
}

/**
 * One or two lines for the move card:
 * - played move is Maia's top move: "A very common mistake at 1500: 38% of players play this.";
 * - otherwise: "At 1500, 41% would play Nf3 here (Bc4?? in the game: 8%).";
 * - second line when Stockfish's move is rarely chosen (< 5%): "The engine move Qh5 is hard to
 *   find: only 3% at 1500."; else, for an unusual move made in time trouble, "Unusual at 1500 —
 *   likely a time-trouble slip.".
 */
export function hintLines(
  hint: MaiaHint,
  move: HintMoveInfo,
  level: Pick<MaiaLevel, 'rating' | 'note'>,
  opts: { timeTrouble?: boolean } = {},
): string[] {
  const top = hint.top[0];
  if (!top) return [];
  const lvl = levelText(level);
  const lines: string[] = [];
  if (hint.playedIsTop) {
    const word = CLASS_WORD[move.classification] ?? 'move';
    lines.push(
      `A very common ${word} at ${lvl}: ${pct(hint.playedP ?? top.p)} of players play this.`,
    );
  } else {
    const glyph = CLASS_INFO[move.classification].glyph;
    const played =
      hint.playedP !== undefined
        ? pct(hint.playedP)
        : hint.minP !== undefined
          ? `under ${pct(hint.minP)}`
          : 'rare';
    lines.push(
      `At ${lvl}, ${pct(top.p)} would play ${top.san} here (${move.playedSan}${glyph} in the game: ${played}).`,
    );
  }
  const best = move.bestSan;
  const bestRare =
    best !== undefined &&
    best !== top.san &&
    (hint.bestP !== undefined
      ? hint.bestP < HARD_TO_FIND_P
      : hint.minP !== undefined && hint.minP < HARD_TO_FIND_P);
  if (bestRare) {
    const share = hint.bestP !== undefined ? `only ${pct(hint.bestP)}` : `under ${pct(hint.minP!)}`;
    lines.push(`The engine move ${best} is hard to find: ${share} at ${level.rating}.`);
  } else if (opts.timeTrouble && !hint.playedIsTop && (hint.playedP ?? 0) < UNUSUAL_P) {
    lines.push(`Unusual at ${level.rating} — likely a time-trouble slip.`);
  }
  return lines;
}

/** Short version for the guided tour ("common at 1500"), only for Maia's top move. */
export function hintShortText(hint: MaiaHint | undefined): string | undefined {
  return hint?.playedIsTop ? `common at ${hint.rating}` : undefined;
}

export interface TypicalCounts {
  /** Mistakes/blunders with a hint where the played move was Maia's top move. */
  typical: number;
  /** Mistakes/blunders with a hint where it was not. */
  unusual: number;
  /** Mistakes/blunders without a hint (yet). */
  pending: number;
}

/** Per side: how many mistakes and blunders were Maia's top-1 prediction at the mover's level. */
export function typicalMistakes(
  summary: ReviewSummary,
  hints: Readonly<Record<number, MaiaHint>>,
): Record<'white' | 'black', TypicalCounts> {
  const out = {
    white: { typical: 0, unusual: 0, pending: 0 },
    black: { typical: 0, unusual: 0, pending: 0 },
  };
  for (const m of summary.moves) {
    if (m.classification !== 'mistake' && m.classification !== 'blunder') continue;
    const h = hints[m.ply];
    const c = out[m.mover];
    if (!h) c.pending++;
    else if (h.playedIsTop) c.typical++;
    else c.unusual++;
  }
  return out;
}
