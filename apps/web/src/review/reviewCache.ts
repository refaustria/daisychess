/**
 * Persistent review cache (ADR-016): finished reviews and the analysed positions of review runs,
 * in IndexedDB (`daisychess-reviews`), with an in-memory fallback when IndexedDB is unavailable
 * (private mode, blocked storage, tests). Framework-free; the review store drives it.
 *
 * - `reviews`: one record per game (key {@link gameKey}), the strongest preset reviewed so far.
 * - `positions`: per FEN and search budget the engine result, at most
 *   {@link MAX_STORED_POSITIONS} entries (least recently used dropped first), so a Deep run after
 *   Fast or a review of a game sharing positions only searches what is missing.
 *
 * Every public function swallows storage errors (a failing cache must never fail a review): reads
 * then return nothing, writes are dropped.
 */
import {
  coversPreset,
  reviewGameKey,
  strongerPreset,
  type ReviewPreset,
  type ReviewSummary,
  type StoredReviewRecord,
} from '@daisychess/engine-core';
import type { PositionResult } from './BatchAnalyzer';
import type { MoveDetails } from './details';
import type { ReviewEngineInfo } from './reviewStore';

/** Schema version: bumping it drops all stored data of older versions. */
export const REVIEW_CACHE_VERSION = 1;
export const REVIEW_DB_NAME = 'daisychess-reviews';
export const MAX_STORED_REVIEWS = 500;
export const MAX_STORED_POSITIONS = 20_000;
/** Games shorter than this are not cached. */
export const MIN_CACHED_PLIES = 2;

export type { ReviewPreset };

/** True when a review with preset `stored` makes a run with `requested` unnecessary (deep ≥ fast). */
export const covers = coversPreset;

export { strongerPreset };

/**
 * Deterministic key of a game: SHA-256 (hex) of the start FEN and the UCI moves (engine-core's
 * `reviewGameKey`, shared with the server store). Headers, the viewed ply and the SAN spelling do
 * not matter.
 */
export const gameKey = reviewGameKey;

export interface StoredReview {
  gameKey: string;
  startFen: string;
  /** SAN moves of the game (also used to rule out key collisions). */
  moves: string[];
  preset: ReviewPreset;
  options: { depth?: number; movetime?: number };
  summary: ReviewSummary;
  moveDetails: MoveDetails;
  engine: ReviewEngineInfo;
  createdAt: number;
  version: number;
  /** Maia Elo estimate per side (ADR-024 §5), added once the estimate run finished. */
  elo?: StoredElo;
}

/** The record's optional Elo estimates (ADR-024 §5); the fallback is never stored. */
export type StoredElo = NonNullable<StoredReviewRecord['elo']>;

export interface StoredPosition {
  /** `<optionsKey>|<fen>` */
  id: string;
  fen: string;
  /** Search budget the entry was searched with: `mt:<ms>` or `d:<depth>`. */
  optionsKey: string;
  result: PositionResult;
  usedAt: number;
  version: number;
}

export const positionId = (optionsKey: string, fen: string): string => `${optionsKey}|${fen}`;

/** Where a shown stored review came from: this browser's cache or the server store (ADR-017). */
export type StoredReviewSource = 'local' | 'server';

/**
 * "Loaded from cache (reviewed 25 Oct, deep, server)" for a local hit, "Loaded from server
 * (reviewed 25 Oct, deep)" for a server hit; the year only when it is not this year.
 */
export function cachedReviewLabel(
  r: Pick<StoredReview, 'createdAt' | 'preset' | 'engine'> & { source?: StoredReviewSource },
  now: number = Date.now(),
): string {
  const d = new Date(r.createdAt);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  if (r.source === 'server') return `Loaded from server (reviewed ${date}, ${r.preset})`;
  return `Loaded from cache (reviewed ${date}, ${r.preset}, ${r.engine.kind})`;
}

/** Bounds of the stores ({@link MAX_STORED_REVIEWS}, {@link MAX_STORED_POSITIONS}; tests lower them). */
const limits = { reviews: MAX_STORED_REVIEWS, positions: MAX_STORED_POSITIONS };

interface Backend {
  readonly kind: 'indexeddb' | 'memory';
  getReview(key: string): Promise<StoredReview | undefined>;
  putReview(r: StoredReview): Promise<void>;
  countReviews(): Promise<number>;
  /** Game keys per preset (for the synchronous index). */
  reviewKeys(): Promise<Array<[string, ReviewPreset]>>;
  getPositions(fens: readonly string[]): Promise<StoredPosition[]>;
  putPositions(entries: readonly StoredPosition[]): Promise<void>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// In-memory backend

class MemoryBackend implements Backend {
  readonly kind = 'memory';
  private readonly reviews = new Map<string, StoredReview>();
  private readonly positions = new Map<string, StoredPosition>();

  async getReview(key: string) {
    return this.reviews.get(key);
  }
  async putReview(r: StoredReview) {
    this.reviews.set(r.gameKey, r);
    if (this.reviews.size > limits.reviews) {
      const oldest = [...this.reviews.values()].sort((a, b) => a.createdAt - b.createdAt);
      for (const o of oldest.slice(0, this.reviews.size - limits.reviews)) {
        this.reviews.delete(o.gameKey);
      }
    }
  }
  async countReviews() {
    return this.reviews.size;
  }
  async reviewKeys() {
    return [...this.reviews.values()].map((r): [string, ReviewPreset] => [r.gameKey, r.preset]);
  }
  async getPositions(fens: readonly string[]) {
    const wanted = new Set(fens);
    return [...this.positions.values()].filter((p) => wanted.has(p.fen));
  }
  async putPositions(entries: readonly StoredPosition[]) {
    for (const e of entries) this.positions.set(e.id, e);
    if (this.positions.size > limits.positions) {
      const target = Math.floor(limits.positions * 0.9);
      const lru = [...this.positions.values()].sort((a, b) => a.usedAt - b.usedAt);
      for (const o of lru.slice(0, this.positions.size - target)) this.positions.delete(o.id);
    }
  }
  async clear() {
    this.reviews.clear();
    this.positions.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// IndexedDB backend

const REVIEWS = 'reviews';
const POSITIONS = 'positions';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Opens (and on a version change recreates) the database. Older schema versions are dropped. */
function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = factory.open(REVIEW_DB_NAME, schemaVersion);
    } catch (err) {
      reject(err);
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      const reviews = db.createObjectStore(REVIEWS, { keyPath: 'gameKey' });
      reviews.createIndex('createdAt', 'createdAt');
      reviews.createIndex('preset', 'preset');
      const positions = db.createObjectStore(POSITIONS, { keyPath: 'id' });
      positions.createIndex('fen', 'fen');
      positions.createIndex('usedAt', 'usedAt');
    };
    r.onsuccess = () => {
      const db = r.result;
      // A newer version in another tab: let it upgrade (this tab then degrades to no-ops).
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'));
    r.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

/** Deletes the oldest records (by `index`) until at most `keep` remain. */
async function trim(db: IDBDatabase, store: string, index: string, max: number, keep: number) {
  const tx = db.transaction(store, 'readwrite');
  const done = complete(tx);
  const os = tx.objectStore(store);
  const count = await request(os.count());
  if (count > max) {
    let excess = count - keep;
    const cursorReq = os.index(index).openCursor();
    await new Promise<void>((resolve, reject) => {
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (!c || excess <= 0) return resolve();
        c.delete();
        excess--;
        c.continue();
      };
    });
  }
  await done;
}

class IdbBackend implements Backend {
  readonly kind = 'indexeddb';
  constructor(private readonly db: IDBDatabase) {}

  async getReview(key: string) {
    const tx = this.db.transaction(REVIEWS, 'readonly');
    const r = (await request(tx.objectStore(REVIEWS).get(key))) as StoredReview | undefined;
    return r && r.version === schemaVersion ? r : undefined;
  }
  async putReview(r: StoredReview) {
    const tx = this.db.transaction(REVIEWS, 'readwrite');
    tx.objectStore(REVIEWS).put(r);
    await complete(tx);
    await trim(this.db, REVIEWS, 'createdAt', limits.reviews, limits.reviews);
  }
  async countReviews() {
    const tx = this.db.transaction(REVIEWS, 'readonly');
    return request(tx.objectStore(REVIEWS).count());
  }
  async reviewKeys() {
    const tx = this.db.transaction(REVIEWS, 'readonly');
    const index = tx.objectStore(REVIEWS).index('preset');
    const presets = ['fast', 'deep'] as const;
    const keys = await Promise.all(
      presets.map((p) => request(index.getAllKeys(IDBKeyRange.only(p)))),
    );
    return presets.flatMap((p, i) => keys[i]!.map((k): [string, ReviewPreset] => [String(k), p]));
  }
  async getPositions(fens: readonly string[]) {
    const tx = this.db.transaction(POSITIONS, 'readonly');
    const index = tx.objectStore(POSITIONS).index('fen');
    const lists = await Promise.all(
      [...new Set(fens)].map((f) => request(index.getAll(IDBKeyRange.only(f)))),
    );
    return (lists.flat() as StoredPosition[]).filter((p) => p.version === schemaVersion);
  }
  async putPositions(entries: readonly StoredPosition[]) {
    if (entries.length === 0) return;
    const tx = this.db.transaction(POSITIONS, 'readwrite');
    const os = tx.objectStore(POSITIONS);
    for (const e of entries) os.put(e);
    await complete(tx);
    await trim(this.db, POSITIONS, 'usedAt', limits.positions, Math.floor(limits.positions * 0.9));
  }
  async clear() {
    const tx = this.db.transaction([REVIEWS, POSITIONS], 'readwrite');
    tx.objectStore(REVIEWS).clear();
    tx.objectStore(POSITIONS).clear();
    await complete(tx);
  }
}

// ---------------------------------------------------------------------------------------------
// Module state and public API

/** `undefined`: `globalThis.indexedDB` at first use; `null`: memory only. */
let factoryOverride: IDBFactory | null | undefined;
/** {@link REVIEW_CACHE_VERSION}, or a test override. */
let schemaVersion = REVIEW_CACHE_VERSION;
let backendPromise: Promise<Backend> | null = null;
/** gameKey → strongest stored preset (synchronous answer for the review store). */
const known = new Map<string, ReviewPreset>();
let indexLoaded = false;
const listeners = new Set<() => void>();

async function init(): Promise<Backend> {
  const factory =
    factoryOverride === undefined
      ? (globalThis as { indexedDB?: IDBFactory }).indexedDB
      : factoryOverride;
  let b: Backend = new MemoryBackend();
  if (factory) {
    try {
      b = new IdbBackend(await openDb(factory));
    } catch (err) {
      console.warn('Review cache: IndexedDB unavailable, keeping reviews in memory', err);
    }
  }
  try {
    for (const [k, p] of await b.reviewKeys()) known.set(k, strongerPreset(known.get(k), p));
  } catch {
    // The index stays empty: every lookup then goes to the store (async path).
  }
  indexLoaded = true;
  return b;
}

const backend = (): Promise<Backend> => (backendPromise ??= init());

const notify = (): void => {
  for (const l of listeners) l();
};

/**
 * Selects the storage (tests): an `IDBFactory` (e.g. fake-indexeddb), `null` for memory only, or
 * `undefined` for `globalThis.indexedDB`; `version` overrides the schema version, `maxReviews` /
 * `maxPositions` the bounds. Forgets the
 * current backend and index (data stays in the database).
 */
export function configureReviewCache(
  factory: IDBFactory | null | undefined,
  opts: { version?: number; maxReviews?: number; maxPositions?: number } = {},
): void {
  factoryOverride = factory;
  schemaVersion = opts.version ?? REVIEW_CACHE_VERSION;
  limits.reviews = opts.maxReviews ?? MAX_STORED_REVIEWS;
  limits.positions = opts.maxPositions ?? MAX_STORED_POSITIONS;
  backendPromise = null;
  known.clear();
  indexLoaded = false;
}

/** Opens the store and loads the index ahead of the first lookup (app start). */
export async function warmReviewCache(): Promise<void> {
  await backend();
}

/** Which storage is in use (after {@link warmReviewCache}). */
export async function reviewCacheKind(): Promise<Backend['kind']> {
  return (await backend()).kind;
}

/**
 * The strongest preset stored for `key` as far as this tab knows, synchronously; undefined when
 * nothing is known (or the index is still loading — the caller then asks the store).
 */
export function peekStoredPreset(key: string): ReviewPreset | undefined {
  return indexLoaded ? known.get(key) : undefined;
}

export async function getStoredReview(key: string): Promise<StoredReview | undefined> {
  try {
    return await (await backend()).getReview(key);
  } catch {
    return undefined;
  }
}

/** Stores `r` unless a review with a stronger preset is stored for the same game already. */
export async function putStoredReview(r: StoredReview): Promise<void> {
  try {
    const b = await backend();
    const prev = await b.getReview(r.gameKey);
    if (prev && !covers(r.preset, prev.preset)) return;
    await b.putReview({ ...r, version: schemaVersion });
    known.set(r.gameKey, strongerPreset(known.get(r.gameKey), r.preset));
    notify();
  } catch (err) {
    console.warn('Review cache: could not store the review', err);
  }
}

export async function countStoredReviews(): Promise<number> {
  try {
    return await (await backend()).countReviews();
  } catch {
    return 0;
  }
}

export async function getStoredPositions(fens: readonly string[]): Promise<StoredPosition[]> {
  try {
    return await (await backend()).getPositions(fens);
  } catch {
    return [];
  }
}

export async function putStoredPositions(entries: readonly StoredPosition[]): Promise<void> {
  try {
    await (await backend()).putPositions(entries.map((e) => ({ ...e, version: schemaVersion })));
  } catch (err) {
    console.warn('Review cache: could not store positions', err);
  }
}

/** Removes all stored reviews and positions. */
export async function clearReviewCache(): Promise<void> {
  try {
    await (await backend()).clear();
  } catch (err) {
    console.warn('Review cache: could not clear', err);
  }
  known.clear();
  notify();
}

/** Called after a review was stored or the cache was cleared (e.g. the Settings count). */
export function onReviewCacheChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
