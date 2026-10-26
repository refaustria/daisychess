import type { CsvPuzzle } from './csv.js';
import {
  BAND_SIZE,
  MAX_BAND,
  MIN_BAND,
  type Puzzle,
  type PuzzleRow,
  type RowDictionary,
} from './schemas.js';

/** Theme and opening lists of one build, plus which opening tags are families. */
export interface PuzzleDictionary extends RowDictionary {
  themes: string[];
  openings: string[];
  /** Indexes into `openings` of the family tags (the first tag of a row). */
  families: number[];
}

/** Rating band of a rating: `floor(rating / 100) * 100`, clamped to 500…2900. */
export function bandOf(rating: number): number {
  const b = Math.floor(rating / BAND_SIZE) * BAND_SIZE;
  return Math.min(MAX_BAND, Math.max(MIN_BAND, b));
}

/**
 * Theme and opening lists of a set of puzzles, sorted (stable across builds of the same data).
 * Families are the tags that occur first in some row (lichess puts the family tag first).
 */
export function buildDictionary(
  puzzles: Iterable<Pick<CsvPuzzle, 'themes' | 'openings'>>,
): PuzzleDictionary {
  const themes = new Set<string>();
  const openings = new Set<string>();
  const families = new Set<string>();
  for (const p of puzzles) {
    for (const t of p.themes) themes.add(t);
    for (const o of p.openings) openings.add(o);
    if (p.openings[0] !== undefined) families.add(p.openings[0]);
  }
  const openingList = [...openings].sort();
  return {
    themes: [...themes].sort(),
    openings: openingList,
    families: openingList.flatMap((o, i) => (families.has(o) ? [i] : [])),
  };
}

function indexer(list: readonly string[]): (key: string) => number {
  const map = new Map(list.map((k, i) => [k, i]));
  return (key) => {
    const i = map.get(key);
    if (i === undefined) throw new RangeError(`unknown key ${key}`);
    return i;
  };
}

/**
 * Compact row of a puzzle against `dict`. Throws a `RangeError` when a theme or opening is
 * missing from the dictionary. For many rows use {@link rowEncoder} (builds the lookup once).
 */
export function encodeRow(p: CsvPuzzle, dict: RowDictionary): PuzzleRow {
  return rowEncoder(dict)(p);
}

/** `encodeRow` with the dictionary lookup built once. */
export function rowEncoder(dict: RowDictionary): (p: CsvPuzzle) => PuzzleRow {
  const theme = indexer(dict.themes);
  const opening = indexer(dict.openings);
  return (p) => [
    p.id,
    p.fen,
    p.moves.join(' '),
    p.rating,
    p.rd,
    p.themes.map(theme),
    p.openings.map(opening),
    p.game,
  ];
}

/**
 * Runtime puzzle of a compact row. `index` is the file the row came with (index or starter).
 * Throws a `RangeError` when a theme/opening index is out of range — the caller treats the whole
 * shard as missing (ADR-023 §3: a shard that fails validation is never data).
 */
export function decodeRow(row: PuzzleRow, index: RowDictionary): Puzzle {
  const [id, fen, moves, rating, rd, themeIdx, openingIdx, game] = row;
  const look = (list: readonly string[], i: number): string => {
    const v = list[i];
    if (v === undefined) throw new RangeError(`index ${i} out of range in ${id}`);
    return v;
  };
  const puzzle: Puzzle = {
    id,
    fen,
    moves: moves.split(' '),
    rating,
    rd,
    themes: themeIdx.map((i) => look(index.themes, i)),
    openings: openingIdx.map((i) => look(index.openings, i)),
    source: 'lichess',
  };
  if (game) puzzle.game = game;
  return puzzle;
}
