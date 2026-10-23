import { START_FEN, type GameState } from '../store/gameStore';

export interface Opening {
  eco: string;
  name: string;
  /** Number of half-moves played when the named position was reached. */
  ply: number;
}

type Entry = { eco: string; name: string };

let table: Map<string, Entry> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Lazy-loads the vendored table (a separate chunk). Safe to call repeatedly. */
export function loadOpenings(): Promise<void> {
  loading ??= import('./data/openings.json').then((m) => {
    const rows = m.default as unknown as [string, string, string][];
    const map = new Map<string, Entry>();
    for (const [eco, name, epd] of rows) map.set(epd, { eco, name });
    table = map;
    cache = null;
    listeners.forEach((l) => l());
  });
  return loading;
}

export const openingsLoaded = (): boolean => table !== null;

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
