import { openingFamily } from './openings.js';
import { BAND_SIZE, MAX_BAND, type Puzzle, type PuzzleIndex, type ShardEntry } from './schemas.js';

export type Difficulty = 'easier' | 'normal' | 'harder';

/** Puzzle filter: one theme key and/or one opening tag (family or variation). */
export interface PuzzleFilter {
  theme?: string;
  opening?: string;
}

/** Inclusive rating window. */
export interface RatingWindow {
  min: number;
  max: number;
}

/** Each widening step adds this much on both sides (ADR-023 §5: twice before any band). */
export const WIDEN_STEP = 200;
/** Shard fetches per request at most. */
export const MAX_SHARD_FETCHES = 3;

/**
 * Rating window for the user's rating `r`: normal `[r − 100, r + 200]`, easier
 * `[r − 300, r − 50]`, harder `[r + 150, r + 450]`; `widen` steps of ±200 each.
 */
export function difficultyWindow(
  rating: number,
  difficulty: Difficulty = 'normal',
  widen = 0,
): RatingWindow {
  const [lo, hi] =
    difficulty === 'easier' ? [-300, -50] : difficulty === 'harder' ? [150, 450] : [-100, 200];
  const w = Math.max(0, widen) * WIDEN_STEP;
  return { min: Math.round(rating + lo - w), max: Math.round(rating + hi + w) };
}

/** True when the puzzle has the filter's theme and opening tag (an empty filter matches all). */
export function matchesFilter(
  puzzle: Pick<Puzzle, 'themes' | 'openings'>,
  filter: PuzzleFilter = {},
): boolean {
  if (filter.theme && !puzzle.themes.includes(filter.theme)) return false;
  if (filter.opening && !puzzle.openings.includes(filter.opening)) return false;
  return true;
}

const inWindow = (rating: number | undefined, w: RatingWindow): boolean =>
  rating !== undefined && rating >= w.min && rating <= w.max;

/** True when band `band` (100 wide, the last one open-ended) overlaps the window. */
function bandOverlaps(band: number, w: RatingWindow): boolean {
  const top = band >= MAX_BAND ? Infinity : band + BAND_SIZE - 1;
  return band <= w.max && top >= w.min;
}

/**
 * Upper bound of the puzzles of `shard` matching `filter` (its count, the theme count, the
 * family count of the opening tag — the smallest applicable one).
 */
export function shardWeight(
  index: PuzzleIndex,
  shard: ShardEntry,
  filter: PuzzleFilter = {},
): number {
  let weight = shard.count;
  if (filter.theme) {
    const t = index.themes.indexOf(filter.theme);
    weight = Math.min(weight, t < 0 ? 0 : (shard.themes[t] ?? 0));
  }
  if (filter.opening) {
    const families = index.families.map((i) => index.openings[i]!);
    const family = openingFamily(filter.opening, families);
    const f = family === undefined ? -1 : index.openings.indexOf(family);
    weight = Math.min(weight, f < 0 ? 0 : (shard.families[f] ?? 0));
  }
  return weight;
}

/**
 * Candidate shards for a request: shards whose band overlaps `window` and that can hold a
 * matching puzzle, sampled without replacement weighted by {@link shardWeight}; at most `max`
 * (default 3). `exclude` names files to skip (already tried or known empty).
 */
export function chooseShards(
  index: PuzzleIndex,
  opts: {
    window: RatingWindow;
    filter?: PuzzleFilter;
    exclude?: ReadonlySet<string>;
    max?: number;
    random?: () => number;
  },
): ShardEntry[] {
  const random = opts.random ?? Math.random;
  const pool = index.shards
    .filter((s) => bandOverlaps(s.band, opts.window) && !opts.exclude?.has(s.file))
    .map((s) => ({ s, w: shardWeight(index, s, opts.filter) }))
    .filter((x) => x.w > 0);
  const out: ShardEntry[] = [];
  const max = opts.max ?? MAX_SHARD_FETCHES;
  while (out.length < max && pool.length > 0) {
    const total = pool.reduce((sum, x) => sum + x.w, 0);
    let pick = random() * total;
    let i = 0;
    for (; i < pool.length - 1; i++) {
      pick -= pool[i]!.w;
      if (pick < 0) break;
    }
    out.push(pool[i]!.s);
    pool.splice(i, 1);
  }
  return out;
}

type Seen = ReadonlySet<string> | ((id: string) => boolean);
const seenFn = (seen: Seen | undefined): ((id: string) => boolean) =>
  seen === undefined ? () => false : typeof seen === 'function' ? seen : (id) => seen.has(id);

/**
 * A random puzzle of `puzzles` within `window` that matches `filter` and is not `seen`, or
 * undefined when none qualifies.
 */
export function choosePuzzle(
  puzzles: readonly Puzzle[],
  opts: { window: RatingWindow; filter?: PuzzleFilter; seen?: Seen; random?: () => number },
): Puzzle | undefined {
  const isSeen = seenFn(opts.seen);
  const candidates = puzzles.filter(
    (p) => inWindow(p.rating, opts.window) && matchesFilter(p, opts.filter) && !isSeen(p.id),
  );
  if (candidates.length === 0) return undefined;
  const i = Math.floor((opts.random ?? Math.random)() * candidates.length);
  return candidates[Math.min(i, candidates.length - 1)];
}

/** First day of the daily sequence. */
export const DAILY_EPOCH_UTC = Date.UTC(2026, 0, 1);
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of `date` in UTC. */
export function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Index into the starter's `daily` list for a UTC date (`Date` or `YYYY-MM-DD`):
 * `daysSince(2026-01-01 UTC) mod poolSize` (non-negative also before the epoch).
 */
export function dailyIndex(dateUtc: Date | string, poolSize: number): number {
  if (!Number.isInteger(poolSize) || poolSize < 1) throw new RangeError('poolSize must be ≥ 1');
  let ms: number;
  if (typeof dateUtc === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateUtc);
    if (!m) throw new RangeError(`not a YYYY-MM-DD date: ${dateUtc}`);
    ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else {
    ms = Date.UTC(dateUtc.getUTCFullYear(), dateUtc.getUTCMonth(), dateUtc.getUTCDate());
  }
  if (!Number.isFinite(ms)) throw new RangeError('invalid date');
  const days = Math.round((ms - DAILY_EPOCH_UTC) / DAY_MS);
  return ((days % poolSize) + poolSize) % poolSize;
}

export interface RushOptions {
  /** Puzzles in a run. */
  count: number;
  /** Target rating of the first puzzle. */
  start: number;
  /** Target increase per puzzle. */
  step: number;
  /** Random pick among this many puzzles nearest to the target. */
  spread: number;
  random: () => number;
}

export const RUSH_DEFAULTS: RushOptions = {
  count: 60,
  start: 800,
  step: 25,
  spread: 5,
  random: Math.random,
};

/**
 * A rush run: for target ratings `start + i·step` the puzzle nearest to the target (random among
 * the `spread` nearest; targets beyond the pool's range get its extremes), never a puzzle of
 * `seen` and never twice. Unrated puzzles are ignored. Shorter than `count` when the pool runs out.
 */
export function rushPlan(
  pool: readonly Puzzle[],
  seen: Iterable<string>,
  options: Partial<RushOptions> = {},
): Puzzle[] {
  const o = { ...RUSH_DEFAULTS, ...options };
  const skip = new Set(seen);
  const byId = new Map<string, Puzzle>();
  for (const p of pool) if (p.rating !== undefined && !skip.has(p.id)) byId.set(p.id, p);
  const sorted = [...byId.values()].sort((a, b) => a.rating! - b.rating! || (a.id < b.id ? -1 : 1));
  const used = new Uint8Array(sorted.length);
  const out: Puzzle[] = [];
  for (let i = 0; i < o.count && out.length < sorted.length; i++) {
    const target = o.start + i * o.step;
    // First index with rating >= target, then expand outwards over unused entries.
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.rating! < target) lo = mid + 1;
      else hi = mid;
    }
    const near: number[] = [];
    let left = lo - 1;
    let right = lo;
    while (near.length < Math.max(1, o.spread) && (left >= 0 || right < sorted.length)) {
      while (left >= 0 && used[left]) left--;
      while (right < sorted.length && used[right]) right++;
      const dl = left >= 0 ? target - sorted[left]!.rating! : Infinity;
      const dr = right < sorted.length ? sorted[right]!.rating! - target : Infinity;
      if (dl === Infinity && dr === Infinity) break;
      if (dr <= dl) near.push(right++);
      else near.push(left--);
    }
    if (near.length === 0) break;
    const k = near[Math.min(near.length - 1, Math.floor(o.random() * near.length))]!;
    used[k] = 1;
    out.push(sorted[k]!);
  }
  return out;
}
