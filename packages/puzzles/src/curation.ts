import type { CsvPuzzle } from './csv.js';
import { bandOf, buildDictionary, rowEncoder, type PuzzleDictionary } from './rows.js';
import {
  BAND_SIZE,
  MAX_BAND,
  MIN_BAND,
  PUZZLE_FORMAT,
  type DatasetInfo,
  type PuzzleIndex,
  type PuzzleRow,
  type ShardEntry,
  type Starter,
} from './schemas.js';

/** Hard filter thresholds (ADR-023 §4). */
export const HARD_FILTER = {
  minPopularity: 90,
  maxRd: 80,
  minPlays: 300,
  minRating: 500,
} as const;

/** Largest accepted starter file (raw bytes of the JSON). */
export const STARTER_MAX_BYTES = 1_000_000;

/**
 * Quality filter of pass 1: popularity ≥ 90, RD ≤ 80, ≥ 300 plays, rating ≥ 500. Structure
 * (FEN length, 2…20 plies) is checked by `rowFromCsv`; legality by `lineIsLegal`/`rowFromCsv`.
 */
export function hardFilter(p: CsvPuzzle): boolean {
  return (
    p.popularity >= HARD_FILTER.minPopularity &&
    p.rd <= HARD_FILTER.maxRd &&
    p.nbPlays >= HARD_FILTER.minPlays &&
    p.rating >= HARD_FILTER.minRating
  );
}

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
/** Most played first; id breaks ties so every run picks the same rows. */
const byPlays = (a: CsvPuzzle, b: CsvPuzzle): number => b.nbPlays - a.nbPlays || byId(a, b);

export interface CurationOptions {
  /** Most played rows kept per 100-point band. */
  quotaPerBand: number;
  /** Every theme is topped up to at least this many rows (most played first). */
  themeFloor: number;
  /** Bands considered (inclusive); rows of other bands are ignored. Default 500…2900. */
  minBand?: number;
  maxBand?: number;
}

/** The selection with per-theme counts (internal state of the curation). */
function select(puzzles: readonly CsvPuzzle[], opts: CurationOptions): Map<string, CsvPuzzle> {
  const minBand = opts.minBand ?? MIN_BAND;
  const maxBand = opts.maxBand ?? MAX_BAND;
  const pool = puzzles
    .filter((p) => {
      const b = bandOf(p.rating);
      return b >= minBand && b <= maxBand;
    })
    .sort(byPlays);
  const chosen = new Map<string, CsvPuzzle>();
  const perBand = new Map<number, number>();
  for (const p of pool) {
    const b = bandOf(p.rating);
    const n = perBand.get(b) ?? 0;
    if (n >= opts.quotaPerBand || chosen.has(p.id)) continue;
    perBand.set(b, n + 1);
    chosen.set(p.id, p);
  }
  const counts = new Map<string, number>();
  for (const p of chosen.values())
    for (const t of p.themes) counts.set(t, (counts.get(t) ?? 0) + 1);
  const allThemes = [...new Set(pool.flatMap((p) => p.themes))].sort();
  for (const theme of allThemes) {
    if ((counts.get(theme) ?? 0) >= opts.themeFloor) continue;
    for (const p of pool) {
      if ((counts.get(theme) ?? 0) >= opts.themeFloor) break;
      if (chosen.has(p.id) || !p.themes.includes(theme)) continue;
      chosen.set(p.id, p);
      for (const t of p.themes) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return chosen;
}

/**
 * Pass 2 of the pipeline: per 100-point band the `quotaPerBand` most played rows, then every
 * theme topped up to `themeFloor` rows (most played first) so rare themes stay available.
 * Returns the selection sorted by id. Input should already pass {@link hardFilter}.
 */
export function selectCurated(
  puzzles: readonly CsvPuzzle[],
  opts: CurationOptions = { quotaPerBand: 16_000, themeFloor: 600 },
): CsvPuzzle[] {
  return [...select(puzzles, opts).values()].sort(byId);
}

export interface StarterOptions {
  /** Upper bound of rows. */
  size: number;
  quotaPerBand: number;
  themeFloor: number;
  /** Bands (inclusive): 600…2500 = ratings 600–2599. */
  minBand: number;
  maxBand: number;
}

export const STARTER_DEFAULTS: StarterOptions = {
  size: 6000,
  quotaPerBand: 300,
  themeFloor: 20,
  minBand: 600,
  maxBand: 2500,
};

/**
 * The bundled starter set: chosen like {@link selectCurated} (quota per band, theme floor) over
 * bands `minBand…maxBand`, then trimmed to `size` by dropping the least played rows of the
 * fullest bands that no theme needs for its floor. Sorted by id.
 */
export function pickStarter(
  curated: readonly CsvPuzzle[],
  options: Partial<StarterOptions> = {},
): CsvPuzzle[] {
  const opts = { ...STARTER_DEFAULTS, ...options };
  const chosen = select(curated, opts);
  if (chosen.size > opts.size) {
    const counts = new Map<string, number>();
    const bands = new Map<number, CsvPuzzle[]>();
    for (const p of chosen.values()) {
      for (const t of p.themes) counts.set(t, (counts.get(t) ?? 0) + 1);
      const b = bandOf(p.rating);
      const list = bands.get(b) ?? [];
      list.push(p);
      bands.set(b, list);
    }
    // Most played first: scanning from the end finds the least played removable row.
    for (const list of bands.values()) list.sort(byPlays);
    const removable = (p: CsvPuzzle): boolean =>
      p.themes.every((t) => (counts.get(t) ?? 0) > opts.themeFloor);
    let excess = chosen.size - opts.size;
    while (excess > 0) {
      const order = [...bands.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
      let removed = false;
      for (const [, list] of order) {
        for (let i = list.length - 1; i >= 0; i--) {
          const p = list[i]!;
          if (!removable(p)) continue;
          list.splice(i, 1);
          chosen.delete(p.id);
          for (const t of p.themes) counts.set(t, (counts.get(t) ?? 0) - 1);
          removed = true;
          break;
        }
        if (removed) break;
      }
      if (!removed) break; // every remaining row holds a theme floor
      excess--;
    }
  }
  return [...chosen.values()].sort(byId);
}

export interface DailyPoolOptions {
  size: number;
  /** PRNG seed of the shuffle (difficulty varies from day to day). */
  seed: number;
  minRating: number;
  maxRating: number;
  minPopularity: number;
  maxRd: number;
}

export const DAILY_DEFAULTS: DailyPoolOptions = {
  size: 1000,
  seed: 20260101,
  minRating: 1300,
  maxRating: 2000,
  minPopularity: 95,
  maxRd: 75,
};

/**
 * Daily pool of the starter: indexes into `starter` of up to `size` rows with rating
 * 1300–2000 (inclusive), popularity ≥ 95 and RD ≤ 75, shuffled with a seeded PRNG.
 */
export function pickDailyPool(
  starter: readonly CsvPuzzle[],
  options: Partial<DailyPoolOptions> = {},
): number[] {
  const o = { ...DAILY_DEFAULTS, ...options };
  const eligible: number[] = [];
  starter.forEach((p, i) => {
    if (
      p.rating >= o.minRating &&
      p.rating <= o.maxRating &&
      p.popularity >= o.minPopularity &&
      p.rd <= o.maxRd
    )
      eligible.push(i);
  });
  const random = seededRandom(o.seed);
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j]!, eligible[i]!];
  }
  return eligible.slice(0, o.size);
}

/** Rows of one shard before it is serialised and named (the pipeline hashes the JSON). */
export interface ShardDraft {
  band: number;
  rows: PuzzleRow[];
}

/**
 * Splits the curated puzzles into shards of at most `maxRows` rows of one band, sorted by id;
 * a band with more rows is split into equal parts. Ordered by band, then by first id.
 */
export function shardByBand(
  puzzles: readonly CsvPuzzle[],
  dict: PuzzleDictionary,
  opts: { maxRows: number } = { maxRows: 2000 },
): ShardDraft[] {
  if (!(opts.maxRows >= 1)) throw new RangeError('maxRows must be ≥ 1');
  const encode = rowEncoder(dict);
  const bands = new Map<number, CsvPuzzle[]>();
  for (const p of puzzles) {
    const b = bandOf(p.rating);
    const list = bands.get(b) ?? [];
    list.push(p);
    bands.set(b, list);
  }
  const out: ShardDraft[] = [];
  for (const band of [...bands.keys()].sort((a, b) => a - b)) {
    const list = bands.get(band)!.sort(byId);
    const parts = Math.ceil(list.length / opts.maxRows);
    const per = Math.ceil(list.length / parts);
    for (let i = 0; i < list.length; i += per) {
      out.push({ band, rows: list.slice(i, i + per).map(encode) });
    }
  }
  return out;
}

/** A written shard: its draft plus the file name and serialised size. */
export interface WrittenShard extends ShardDraft {
  /** `shards/<band>-<16 hex>.json` */
  file: string;
  bytes: number;
}

/**
 * `index.json` for the written shards: per-shard counts of themes and opening families (the
 * family of a row is its first opening tag), global counts of every theme and opening tag, and
 * the dataset info with `total` = rows in all shards.
 */
export function buildIndex(input: {
  dataset: Omit<DatasetInfo, 'total'>;
  dictionary: PuzzleDictionary;
  shards: readonly WrittenShard[];
}): PuzzleIndex {
  const { dictionary: dict } = input;
  const familySet = new Set(dict.families);
  const themeTotals = new Array<number>(dict.themes.length).fill(0);
  const openingTotals = new Array<number>(dict.openings.length).fill(0);
  let total = 0;
  const shards: ShardEntry[] = input.shards.map((s) => {
    const themes: Record<number, number> = {};
    const families: Record<number, number> = {};
    for (const row of s.rows) {
      for (const t of row[5]) {
        themes[t] = (themes[t] ?? 0) + 1;
        themeTotals[t] = (themeTotals[t] ?? 0) + 1;
      }
      for (const o of row[6]) openingTotals[o] = (openingTotals[o] ?? 0) + 1;
      const fam = row[6][0];
      if (fam !== undefined && familySet.has(fam)) families[fam] = (families[fam] ?? 0) + 1;
    }
    total += s.rows.length;
    return { file: s.file, band: s.band, count: s.rows.length, bytes: s.bytes, themes, families };
  });
  return {
    format: PUZZLE_FORMAT,
    dataset: { ...input.dataset, total },
    themes: [...dict.themes],
    openings: [...dict.openings],
    families: [...dict.families],
    bandSize: BAND_SIZE,
    shards,
    counts: { themes: themeTotals, openings: openingTotals },
  };
}

/**
 * The starter file: its own dictionary (only the starter's themes/openings), the rows in the
 * given order and the daily pool (indexes into those rows, e.g. from {@link pickDailyPool}).
 */
export function buildStarter(input: {
  dataset: string;
  puzzles: readonly CsvPuzzle[];
  daily: readonly number[];
}): Starter {
  const dict = buildDictionary(input.puzzles);
  const encode = rowEncoder(dict);
  for (const i of input.daily) {
    if (!Number.isInteger(i) || i < 0 || i >= input.puzzles.length)
      throw new RangeError(`daily index ${i} out of range`);
  }
  return {
    format: PUZZLE_FORMAT,
    dataset: input.dataset,
    themes: dict.themes,
    openings: dict.openings,
    rows: input.puzzles.map(encode),
    daily: [...input.daily],
  };
}
