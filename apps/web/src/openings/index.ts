import { START_FEN, type GameState } from '../store/gameStore';
import type { Book, BookMove, BookOpening, OpeningRow } from './book';

export type { Book, BookMove, BookOpening, OpeningRow } from './book';

export interface Opening {
  eco: string;
  name: string;
  /** Number of half-moves played when the named position was reached. */
  ply: number;
  /** The book line (SAN) of the named variation; may differ from the game's move order. */
  moves: readonly string[];
}

type Entry = { eco: string; name: string; moves: readonly string[] };

let table: Map<string, Entry> | null = null;
let book: Book | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Lazy-loads the vendored table and the book (separate chunks). Safe to call repeatedly. */
export function loadOpenings(): Promise<void> {
  // The book code travels with the data (both only needed once the table is wanted).
  loading ??= Promise.all([import('./data/openings.json'), import('./book')]).then(([m, b]) => {
    // The JSON import is typed as `(string)[][]`; the generator guarantees the 4-tuple shape.
    const rows = m.default as unknown as OpeningRow[];
    const map = new Map<string, Entry>();
    // First entry wins for a duplicate position (the generator already drops duplicates).
    for (const [eco, name, epd, line] of rows) {
      if (!map.has(epd)) map.set(epd, { eco, name, moves: line.split(' ').filter(Boolean) });
    }
    table = map;
    book = new b.Book(rows);
    cache = null;
    listeners.forEach((l) => l());
  });
  return loading;
}

export const openingsLoaded = (): boolean => table !== null;

/** The opening book (move lines of every named variation); null until {@link loadOpenings} resolved. */
export const getBook = (): Book | null => book;

/** Subscribe to the table finishing loading (for useSyncExternalStore). */
export function onOpeningsLoaded(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** FEN without the move counters. */
export const toEpd = (fen: string): string => fen.split(' ').slice(0, 4).join(' ');

/**
 * `positions` are the EPDs of every position from the start (index = ply).
 * Returns the deepest position that is a named opening, so transpositions are recognised.
 * Returns null while the table is not loaded.
 */
export function findOpening(positions: string[]): Opening | null {
  if (!table) return null;
  for (let ply = positions.length - 1; ply >= 0; ply--) {
    const hit = table.get(positions[ply]!);
    if (hit) return { ...hit, ply };
  }
  return null;
}

let cache: {
  moves: GameState['moves'];
  ply: number;
  startFen: string;
  value: Opening | null;
} | null = null;

/** Opening as of the current ply of the game; null for custom start positions. Memoised. */
export function openingForGame(s: Pick<GameState, 'startFen' | 'moves' | 'ply'>): Opening | null {
  if (s.startFen !== START_FEN || !table) return null;
  if (cache && cache.moves === s.moves && cache.ply === s.ply && cache.startFen === s.startFen) {
    return cache.value;
  }
  const positions = [toEpd(START_FEN), ...s.moves.slice(0, s.ply).map((m) => toEpd(m.fen))];
  const value = findOpening(positions);
  cache = { moves: s.moves, ply: s.ply, startFen: s.startFen, value };
  return value;
}

// Module-level book API over the loaded table (empty results until `loadOpenings()` resolved).

/** Book continuations after the SAN moves `prefix` (see {@link Book.bookMoves}). */
export const bookMoves = (prefix: readonly string[]): BookMove[] => book?.bookMoves(prefix) ?? [];

/** True when a named line starts with `prefix`. */
export const inBook = (prefix: readonly string[]): boolean => book?.inBook(prefix) ?? false;

/** The SAN line of a variation. */
export const lineFor = (o: Pick<BookOpening, 'moves'>): string[] => [...o.moves];

/** Named sub-variations sharing `o`'s line as prefix. */
export const variationsUnder = (o: Pick<BookOpening, 'moves'>): BookOpening[] =>
  book?.variationsUnder(o) ?? [];

/** Ranked search over name and ECO (see {@link Book.search}). */
export const searchOpenings = (query: string, limit?: number): BookOpening[] =>
  book?.search(query, limit) ?? [];
