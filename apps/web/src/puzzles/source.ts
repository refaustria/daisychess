/**
 * Puzzle data source (ADR-023 §5): the static files under `/puzzles/v1/` (index + shards),
 * cached in IndexedDB (`cache.ts`), with the bundled starter (`starter.ts`) as the offline
 * fallback, and the puzzle selection `nextPuzzle` on top.
 *
 * - {@link puzzleBase}: same origin on the web; the compile-time constant
 *   {@link APP_PUZZLES_URL} (or `VITE_PUZZLES_URL`) inside the apps.
 * - {@link loadIndex}: memory → IndexedDB → network; refreshed after {@link INDEX_MAX_AGE_MS},
 *   a stale copy is used when the refresh fails.
 * - {@link fetchShard}: one shard, validated with Zod (an invalid file is treated as missing),
 *   stored in the cache.
 * - {@link nextPuzzle}: window by rating/difficulty, candidate shards weighted by their matching
 *   counts, at most {@link MAX_SHARD_FETCHES} fetches per request, the window widened by ±200
 *   twice before any band is accepted, the starter at every step, seen puzzles skipped.
 * - {@link prefetchOffline}: the first two shards of each band within ±300 of the rating.
 *
 * No credentials, no identifiers: plain CORS `fetch` of static files.
 */
import {
  choosePuzzle,
  chooseShards,
  decodeRow,
  difficultyWindow,
  MAX_BAND,
  MAX_SHARD_FETCHES,
  BAND_SIZE,
  PuzzleIndexSchema,
  ShardSchema,
  type Difficulty,
  type Puzzle,
  type PuzzleFilter,
  type PuzzleIndex,
  type RatingWindow,
  type Shard,
  type ShardEntry,
} from '@daisychess/puzzles';
import { isNativeApp } from '../platform';
import {
  deleteCachedShards,
  getCachedShard,
  getPuzzleMeta,
  listCachedShards,
  putCachedShard,
  putPuzzleMeta,
  type CachedShardInfo,
} from './cache';
import { getPuzzlesState, seenSet } from './puzzlesState';
import { starterPuzzles } from './starter';

/** Puzzle files of the apps (ADR-023 §5; `VITE_PUZZLES_URL` overrides it). */
export const APP_PUZZLES_URL = 'https://play.daisychess.org/puzzles/v1/';
/** The stored index is refreshed when older than this. */
export const INDEX_MAX_AGE_MS = 24 * 3_600_000;
/** After a failed index fetch, no new attempt for this long (offline: no request per puzzle). */
export const INDEX_RETRY_MS = 60_000;
export const INDEX_TIMEOUT_MS = 10_000;
export const SHARD_TIMEOUT_MS = 15_000;
/** Offline prefetch: bands within ± this of the rating … */
export const OFFLINE_SPREAD = 300;
/** … and this many shards of each band. */
export const OFFLINE_SHARDS_PER_BAND = 2;
/** Key of the index in the cache's `meta` store. */
export const INDEX_META_KEY = 'index';

const SHARD_FILE = /^shards\/\d{3,4}-[0-9a-f]{16}\.json$/;

const withSlash = (u: string): string => (u.endsWith('/') ? u : `${u}/`);

/**
 * Base URL of the puzzle files (ends with `/`): `<origin>/puzzles/v1/` on the web; inside the
 * apps (native shell or a non-http(s) origin) `VITE_PUZZLES_URL` or {@link APP_PUZZLES_URL}.
 */
export function puzzleBase(): string {
  if (config.base) return withSlash(config.base);
  const loc = globalThis.location as Location | undefined;
  const httpOrigin = loc?.protocol === 'https:' || loc?.protocol === 'http:';
  if (!loc || !httpOrigin || isNativeApp()) {
    return withSlash(import.meta.env.VITE_PUZZLES_URL || APP_PUZZLES_URL);
  }
  return new URL('/puzzles/v1/', loc.href).href;
}

// ---------------------------------------------------------------------------------------------
// Configuration (tests)

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const config: { fetch?: FetchFn; base?: string; now: () => number } = { now: Date.now };

/**
 * Overrides the network and the clock (tests) and forgets the in-memory index; `{}` restores the
 * defaults.
 */
export function configurePuzzleSource(
  opts: { fetch?: FetchFn; base?: string; now?: () => number } = {},
): void {
  config.fetch = opts.fetch;
  config.base = opts.base;
  config.now = opts.now ?? Date.now;
  memIndex = null;
  indexInflight = null;
  lastIndexFailure = -Infinity;
  decoded.clear();
}

const doFetch: FetchFn = (input, init) => (config.fetch ?? globalThis.fetch)(input, init);

/** Result of a GET: the body, or why there is none (`network`: unreachable, timeout, abort). */
type TextResult = { text: string } | { error: 'network' | 'status' };

/** GET `url` as text with a timeout. Never throws. */
async function getText(url: string, timeoutMs: number, signal?: AbortSignal): Promise<TextResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = (): void => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) return { error: 'network' };
    const res = await doFetch(url, { credentials: 'omit', mode: 'cors', signal: ctrl.signal });
    if (!res.ok) return { error: 'status' };
    return { text: await res.text() };
  } catch {
    return { error: 'network' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------------------------
// Index

interface StoredIndex {
  index: PuzzleIndex;
  fetchedAt: number;
  /** Base URL it was fetched from (a different base makes it stale). */
  base: string;
}

let memIndex: StoredIndex | null = null;
let indexInflight: Promise<PuzzleIndex | null> | null = null;
let lastIndexFailure = -Infinity;

function parseStored(v: unknown): StoredIndex | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const parsed = PuzzleIndexSchema.safeParse(o.index);
  if (!parsed.success || typeof o.fetchedAt !== 'number' || typeof o.base !== 'string') return null;
  return { index: parsed.data, fetchedAt: o.fetchedAt, base: o.base };
}

const isFresh = (s: StoredIndex, base: string): boolean =>
  s.base === base && config.now() - s.fetchedAt < INDEX_MAX_AGE_MS && s.fetchedAt <= config.now();

async function refreshIndex(
  previous: StoredIndex | null,
  base: string,
): Promise<PuzzleIndex | null> {
  const res = await getText(`${base}index.json`, INDEX_TIMEOUT_MS);
  const parsed = 'text' in res ? PuzzleIndexSchema.safeParse(parseJson(res.text)) : undefined;
  if (!parsed?.success) {
    lastIndexFailure = config.now();
    return previous?.index ?? null;
  }
  const stored: StoredIndex = { index: parsed.data, fetchedAt: config.now(), base };
  memIndex = stored;
  await putPuzzleMeta(INDEX_META_KEY, stored);
  if (previous && previous.index.dataset.sha256 !== stored.index.dataset.sha256) {
    // Shards of an older dataset index the old dictionary: drop them.
    await pruneForeignShards(stored.index);
  }
  return stored.index;
}

/**
 * The puzzle index: the in-memory or stored copy while fresh (24 h, same base), else fetched
 * (validated) and stored; on a failed refresh the stale copy, or null when there is none.
 * `offline: true` never touches the network (e.g. before a rush run). Concurrent calls share one
 * request.
 */
export async function loadIndex(opts: { offline?: boolean } = {}): Promise<PuzzleIndex | null> {
  const base = puzzleBase();
  memIndex ??= parseStored(await getPuzzleMeta(INDEX_META_KEY));
  const known = memIndex;
  if (known && isFresh(known, base)) return known.index;
  if (opts.offline) return known?.index ?? null;
  if (config.now() - lastIndexFailure < INDEX_RETRY_MS) return known?.index ?? null;
  indexInflight ??= refreshIndex(known, base).finally(() => {
    indexInflight = null;
  });
  return indexInflight;
}

/** Deletes cached shards that are not of `index`'s dataset. */
async function pruneForeignShards(index: PuzzleIndex): Promise<void> {
  const foreign = (await listCachedShards())
    .filter((s) => s.dataset !== index.dataset.sha256)
    .map((s) => s.file);
  if (foreign.length > 0) await deleteCachedShards(foreign);
  for (const f of foreign) decoded.delete(f);
}

// ---------------------------------------------------------------------------------------------
// Shards

/**
 * Fetches the shard `file` (relative to {@link puzzleBase}, e.g. `shards/1500-<16 hex>.json`),
 * validates it with Zod and stores it in the cache. Null when the name is not a shard name, the
 * request fails or the file is invalid (never treated as data).
 */
export async function fetchShard(file: string, signal?: AbortSignal): Promise<Shard | null> {
  const r = await loadShard(file, signal);
  return 'shard' in r ? r.shard : null;
}

type ShardResult = { shard: Shard } | { error: 'network' | 'invalid' };

async function loadShard(file: string, signal?: AbortSignal): Promise<ShardResult> {
  if (!SHARD_FILE.test(file)) return { error: 'invalid' };
  const res = await getText(`${puzzleBase()}${file}`, SHARD_TIMEOUT_MS, signal);
  if (!('text' in res)) return { error: res.error === 'network' ? 'network' : 'invalid' };
  const parsed = ShardSchema.safeParse(parseJson(res.text));
  if (!parsed.success) {
    console.warn(`Puzzles: ignoring invalid shard ${file}`);
    return { error: 'invalid' };
  }
  await putCachedShard({ file, ...parsed.data, bytes: res.text.length });
  return { shard: parsed.data };
}

/** Decoded puzzles of recently used shards (file → puzzles), a small LRU. */
const decoded = new Map<string, Puzzle[]>();
const MAX_DECODED = 8;

/** The decoded puzzles of `file` when still in memory (marked as recently used). */
function decodedHit(file: string): Puzzle[] | undefined {
  const hit = decoded.get(file);
  if (hit) {
    decoded.delete(file);
    decoded.set(file, hit);
  }
  return hit;
}

function decodeShard(
  file: string,
  shard: Pick<Shard, 'rows'>,
  index: PuzzleIndex,
): Puzzle[] | null {
  const hit = decodedHit(file);
  if (hit) return hit;
  let puzzles: Puzzle[];
  try {
    puzzles = shard.rows.map((r) => decodeRow(r, index));
  } catch {
    return null; // an index out of range: the shard does not belong to this index
  }
  decoded.set(file, puzzles);
  if (decoded.size > MAX_DECODED) decoded.delete(decoded.keys().next().value!);
  return puzzles;
}

/** Fetch budget and state of one request. */
interface Budget {
  fetches: number;
  /** A fetch failed for network reasons: no further fetches in this request. */
  offline: boolean;
  signal?: AbortSignal;
}

/**
 * Puzzles of `entry`: from the cache when it holds the shard of this dataset, else fetched when
 * the budget allows. Null when unavailable.
 */
async function shardPuzzles(
  index: PuzzleIndex,
  entry: ShardEntry,
  cached: ReadonlyMap<string, CachedShardInfo>,
  budget: Budget,
): Promise<Puzzle[] | null> {
  const hit = decodedHit(entry.file);
  if (hit) return hit;
  const info = cached.get(entry.file);
  if (info && info.dataset === index.dataset.sha256) {
    const shard = await getCachedShard(entry.file);
    if (shard) return decodeShard(entry.file, shard, index);
  }
  if (budget.offline || budget.fetches <= 0 || budget.signal?.aborted) return null;
  budget.fetches--;
  const r = await loadShard(entry.file, budget.signal);
  if (!('shard' in r)) {
    if (r.error === 'network') budget.offline = true;
    return null;
  }
  const { shard } = r;
  if (shard.dataset !== index.dataset.sha256 || shard.band !== entry.band) return null;
  return decodeShard(entry.file, shard, index);
}

// ---------------------------------------------------------------------------------------------
// Selection

const ANY_BAND: RatingWindow = { min: -Infinity, max: Infinity };

export interface NextPuzzleOptions {
  /** Random source (tests). */
  random?: () => number;
  /** Cancels outstanding shard fetches; the result is then null unless already found. */
  signal?: AbortSignal;
  /** Ids to skip besides the seen ring of the puzzle state. */
  exclude?: ReadonlySet<string>;
}

/**
 * The next puzzle for `rating` (the user's Glicko-2 rating) and `difficulty` matching `filter`,
 * or null when nothing qualifies with what is reachable ("No more puzzles for this filter
 * offline"). Per step (window, ±200, ±400, any band): cached/fetched shards of the index weighted
 * by matching counts (≤ 3 fetches per request in all), then the starter. Puzzles in the seen ring
 * are skipped; recording the shown puzzle as seen is the caller's job (`markSeen`).
 */
export async function nextPuzzle(
  filter: PuzzleFilter,
  rating: number,
  difficulty: Difficulty,
  opts: NextPuzzleOptions = {},
): Promise<Puzzle | null> {
  const random = opts.random ?? Math.random;
  const ring = seenSet(getPuzzlesState());
  const seen = opts.exclude
    ? (id: string) => ring.has(id) || opts.exclude!.has(id)
    : (id: string) => ring.has(id);
  const index = await loadIndex();
  const budget: Budget = { fetches: MAX_SHARD_FETCHES, offline: false, signal: opts.signal };
  const cached = new Map(index ? (await listCachedShards()).map((s) => [s.file, s]) : []);
  /** Shards loaded in this request (file → puzzles), reused at wider windows. */
  const loaded = new Map<string, Puzzle[]>();
  const unavailable = new Set<string>();
  let starter: Puzzle[] | null = null;
  const windows = [0, 1, 2].map((w) => difficultyWindow(rating, difficulty, w));
  for (const window of [...windows, ANY_BAND]) {
    if (opts.signal?.aborted) return null;
    if (index) {
      for (const puzzles of loaded.values()) {
        const p = choosePuzzle(puzzles, { window, filter, seen, random });
        if (p) return p;
      }
      const exclude = new Set([...loaded.keys(), ...unavailable]);
      const ordered = chooseShards(index, {
        window,
        filter,
        exclude,
        max: index.shards.length,
        random,
      });
      for (const entry of ordered) {
        if (opts.signal?.aborted) return null;
        const reachable =
          decoded.has(entry.file) ||
          cached.has(entry.file) ||
          (!budget.offline && budget.fetches > 0);
        if (!reachable) continue;
        const puzzles = await shardPuzzles(index, entry, cached, budget);
        if (!puzzles) {
          unavailable.add(entry.file);
          continue;
        }
        loaded.set(entry.file, puzzles);
        const p = choosePuzzle(puzzles, { window, filter, seen, random });
        if (p) return p;
      }
    }
    starter ??= await starterPuzzles();
    const p = choosePuzzle(starter, { window, filter, seen, random });
    if (p) return p;
  }
  return null;
}

/**
 * Every puzzle available without the network: the cached shards of the stored index's dataset
 * and the starter (e.g. the rush pool, which must not fetch during a run).
 */
export async function localPuzzles(): Promise<Puzzle[]> {
  const out: Puzzle[] = [];
  const index = await loadIndex({ offline: true });
  if (index) {
    const infos = (await listCachedShards()).filter((s) => s.dataset === index.dataset.sha256);
    const known = new Set(index.shards.map((s) => s.file));
    for (const info of infos) {
      if (!known.has(info.file)) continue;
      const shard = await getCachedShard(info.file);
      const puzzles = shard ? decodeShard(info.file, shard, index) : null;
      if (puzzles) out.push(...puzzles);
    }
  }
  out.push(...(await starterPuzzles()));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Offline prefetch

/** True when band `band` (the last one open-ended) overlaps `[min, max]`. */
function bandOverlaps(band: number, min: number, max: number): boolean {
  const top = band >= MAX_BAND ? Infinity : band + BAND_SIZE - 1;
  return band <= max && top >= min;
}

/**
 * The shards "Keep puzzles for offline use" fetches: the first {@link OFFLINE_SHARDS_PER_BAND} of
 * each band (index order) within ±{@link OFFLINE_SPREAD} of `rating`. Sum `bytes` for the size
 * hint.
 */
export function offlinePlan(index: PuzzleIndex, rating: number): ShardEntry[] {
  const perBand = new Map<number, number>();
  const out: ShardEntry[] = [];
  for (const s of index.shards) {
    if (!bandOverlaps(s.band, rating - OFFLINE_SPREAD, rating + OFFLINE_SPREAD)) continue;
    const n = perBand.get(s.band) ?? 0;
    if (n >= OFFLINE_SHARDS_PER_BAND) continue;
    perBand.set(s.band, n + 1);
    out.push(s);
  }
  return out;
}

export interface PrefetchProgress {
  /** Shards handled so far (cached, fetched or failed). */
  done: number;
  total: number;
  /** Raw bytes of the shards that are now cached. */
  bytes: number;
  failed: number;
}

export interface PrefetchResult extends PrefetchProgress {
  /** False when there is no index (nothing to fetch) or the run was cancelled. */
  ok: boolean;
  reason?: 'no-index' | 'cancelled';
}

/**
 * Fetches the {@link offlinePlan} shards that are not cached yet, one at a time, reporting
 * progress after each. Cancel with `signal`.
 */
export async function prefetchOffline(
  rating: number,
  opts: { onProgress?: (p: PrefetchProgress) => void; signal?: AbortSignal } = {},
): Promise<PrefetchResult> {
  const index = await loadIndex();
  if (!index) return { ok: false, reason: 'no-index', done: 0, total: 0, bytes: 0, failed: 0 };
  const plan = offlinePlan(index, rating);
  const cached = new Map((await listCachedShards()).map((s) => [s.file, s]));
  const progress: PrefetchProgress = { done: 0, total: plan.length, bytes: 0, failed: 0 };
  opts.onProgress?.({ ...progress });
  for (const entry of plan) {
    if (opts.signal?.aborted) return { ...progress, ok: false, reason: 'cancelled' };
    const have = cached.get(entry.file);
    if (have && have.dataset === index.dataset.sha256) {
      // Touch it so the LRU keeps the offline set.
      await getCachedShard(entry.file);
      progress.bytes += have.bytes;
    } else {
      const shard = await fetchShard(entry.file, opts.signal);
      if (shard) progress.bytes += entry.bytes;
      else progress.failed++;
    }
    progress.done++;
    opts.onProgress?.({ ...progress });
  }
  if (opts.signal?.aborted) return { ...progress, ok: false, reason: 'cancelled' };
  return { ...progress, ok: true };
}
