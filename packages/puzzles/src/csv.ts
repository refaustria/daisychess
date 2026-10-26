import { Chess } from 'chess.js';

/** Column order of `lichess_db_puzzle.csv`. */
export const CSV_COLUMNS = [
  'PuzzleId',
  'FEN',
  'Moves',
  'Rating',
  'RatingDeviation',
  'Popularity',
  'NbPlays',
  'Themes',
  'GameUrl',
  'OpeningTags',
  'DailyDate',
] as const;

/** Longest FEN accepted (a longer one is not a normal position). */
export const MAX_FEN_LENGTH = 100;
/** Shortest and longest accepted line (plies, intro move included). */
export const MIN_PLIES = 2;
export const MAX_PLIES = 20;

const LICHESS_PREFIX = 'https://lichess.org/';
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const ID = /^[0-9A-Za-z]{1,16}$/;
const TAG = /^[A-Za-z0-9_-]{1,80}$/;

/** One validated CSV record (everything curation needs; `popularity`/`nbPlays` are not shipped). */
export interface CsvPuzzle {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  rd: number;
  popularity: number;
  nbPlays: number;
  themes: string[];
  openings: string[];
  /** GameUrl without `https://lichess.org/` (`''` when missing). */
  game: string;
}

export type CsvRejectReason =
  'header' | 'columns' | 'id' | 'number' | 'fen' | 'moves' | 'themes' | 'openings' | 'illegal';

export type CsvRowResult = { ok: true; puzzle: CsvPuzzle } | { ok: false; reason: CsvRejectReason };

/**
 * Splits one CSV line into fields. The lichess file never quotes (no field contains a comma),
 * but RFC 4180 quoting is handled anyway so a re-exported file still parses. A trailing `\r`
 * is dropped.
 */
export function parseCsvLine(line: string): string[] {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!text.includes('"')) return text.split(',');
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

const words = (s: string): string[] => (s.trim() === '' ? [] : s.trim().split(/\s+/));

/**
 * True when `moves` (UCI) is a legal line from `fen` (chess.js). An invalid FEN is illegal too.
 */
export function lineIsLegal(fen: string, moves: readonly string[]): boolean {
  try {
    const chess = new Chess(fen);
    for (const m of moves) {
      chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates one CSV record (a line or its fields) and returns the puzzle, or why it was rejected.
 * Checks: 11 columns, id, integer numbers, FEN ≤ {@link MAX_FEN_LENGTH} chars, 2…20 UCI plies,
 * theme/opening keys, and — unless `checkLegality` is false (the pipeline runs the cheap hard
 * filter first) — that the line is legal with chess.js.
 */
export function rowFromCsv(
  input: string | readonly string[],
  options: { checkLegality?: boolean } = {},
): CsvRowResult {
  const f = typeof input === 'string' ? parseCsvLine(input) : input;
  if (f[0] === CSV_COLUMNS[0]) return { ok: false, reason: 'header' };
  if (f.length !== CSV_COLUMNS.length) return { ok: false, reason: 'columns' };
  const [id, fen, movesText, rating, rd, pop, plays, themesText, url, openingsText] = f as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!ID.test(id)) return { ok: false, reason: 'id' };
  const nums = [rating, rd, pop, plays].map((s) => (/^-?\d+$/.test(s) ? Number(s) : NaN));
  if (nums.some((n) => !Number.isSafeInteger(n))) return { ok: false, reason: 'number' };
  const [r, d, p, n] = nums as [number, number, number, number];
  if (fen.length === 0 || fen.length > MAX_FEN_LENGTH || fen.split(' ').length !== 6)
    return { ok: false, reason: 'fen' };
  const moves = words(movesText);
  if (moves.length < MIN_PLIES || moves.length > MAX_PLIES || !moves.every((m) => UCI.test(m)))
    return { ok: false, reason: 'moves' };
  const themes = words(themesText);
  if (!themes.every((t) => TAG.test(t))) return { ok: false, reason: 'themes' };
  const openings = words(openingsText);
  if (!openings.every((t) => TAG.test(t))) return { ok: false, reason: 'openings' };
  if (options.checkLegality !== false && !lineIsLegal(fen, moves))
    return { ok: false, reason: 'illegal' };
  const game = url.startsWith(LICHESS_PREFIX) ? url.slice(LICHESS_PREFIX.length) : '';
  return {
    ok: true,
    puzzle: {
      id,
      fen,
      moves,
      rating: r,
      rd: d,
      popularity: p,
      nbPlays: n,
      themes,
      openings,
      game: game.length <= 64 ? game : '',
    },
  };
}
