/**
 * Bundled starter set (ADR-023 §3, §4, §8): `data/starter.json` (≤ 1 MB, built by the puzzle
 * pipeline, see `data/SOURCE.md`) loaded lazily as its own chunk, validated once with Zod, and
 * the daily puzzle `starter.daily[dailyIndex(date, daily.length)]` — the same for everyone on the
 * same app release, available offline.
 */
import {
  dailyIndex,
  decodeRow,
  StarterSchema,
  type Puzzle,
  type Starter,
} from '@daisychess/puzzles';

/** The decoded starter: its file plus the puzzles in row order. */
export interface LoadedStarter {
  starter: Starter;
  puzzles: Puzzle[];
}

type StarterImporter = () => Promise<unknown>;

/** The bundled file (separate chunk). */
const bundled: StarterImporter = () =>
  import('./data/starter.json').then((m: { default: unknown }) => m.default);

let importer: StarterImporter = bundled;
let loading: Promise<LoadedStarter | null> | null = null;

/** Replaces the starter source (tests); `null` restores the bundled file. */
export function setStarterImporter(f: StarterImporter | null): void {
  importer = f ?? bundled;
  loading = null;
}

async function load(): Promise<LoadedStarter | null> {
  try {
    const parsed = StarterSchema.safeParse(await importer());
    if (!parsed.success) {
      console.warn('Puzzles: the bundled starter set is invalid', parsed.error);
      return null;
    }
    const starter = parsed.data;
    return { starter, puzzles: starter.rows.map((r) => decodeRow(r, starter)) };
  } catch (err) {
    // A failed chunk load (offline web page with an evicted HTTP cache) or a bad row index.
    console.warn('Puzzles: could not load the starter set', err);
    return null;
  }
}

/**
 * The starter set, loaded and decoded once (later calls share the promise); null when it cannot
 * be loaded or is invalid. A failed load is retried on the next call.
 */
export function loadStarter(): Promise<LoadedStarter | null> {
  const p = (loading ??= load());
  void p.then((r) => {
    if (r === null && loading === p) loading = null;
  });
  return p;
}

/** The starter puzzles (empty when the starter cannot be loaded). */
export async function starterPuzzles(): Promise<Puzzle[]> {
  return (await loadStarter())?.puzzles ?? [];
}

/**
 * The daily puzzle for a UTC date (`Date` or `YYYY-MM-DD`); null without a starter or an empty
 * daily pool.
 */
export async function dailyPuzzle(dateUtc: Date | string): Promise<Puzzle | null> {
  const s = await loadStarter();
  if (!s || s.starter.daily.length === 0) return null;
  const row = s.starter.daily[dailyIndex(dateUtc, s.starter.daily.length)]!;
  return s.puzzles[row] ?? null;
}

/** Puzzles per theme key and per opening tag in the starter (filter counts offline). */
export interface PuzzleCounts {
  themes: Record<string, number>;
  openings: Record<string, number>;
}

/** Counts of the starter (empty maps without a starter). */
export async function starterCounts(): Promise<PuzzleCounts> {
  const out: PuzzleCounts = { themes: {}, openings: {} };
  const s = await loadStarter();
  if (!s) return out;
  for (const p of s.puzzles) {
    for (const t of p.themes) out.themes[t] = (out.themes[t] ?? 0) + 1;
    for (const o of p.openings) out.openings[o] = (out.openings[o] ?? 0) + 1;
  }
  return out;
}
