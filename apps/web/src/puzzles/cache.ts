/**
 * Client cache of the puzzle data (ADR-023 §5, §9, §10): IndexedDB `daisychess-puzzles` with an
 * in-memory fallback when IndexedDB is unavailable (private mode, blocked storage, tests).
 * Framework-free; modelled on `review/reviewCache.ts`.
 *
 * The database and its schema belong to `puzzlesDb.ts` (shared with the stage-2 ledger and
 * mistakes); this module uses two of its stores:
 * - `shards` (key `file`): fetched shard files, at most {@link MAX_CACHED_SHARDS}, the least
 *   recently used dropped first.
 * - `meta` (key `key`): small records, e.g. the puzzle index with its fetch time.
 *
 * Every public function swallows storage errors (a failing cache must never fail a puzzle):
 * reads then return nothing, writes are dropped.
 */
import type { PuzzleRow } from '@daisychess/puzzles';
import { openPuzzlesDb, PUZZLE_STORES, PUZZLES_DB_VERSION } from './puzzlesDb';

/** Shards kept at most (≈ 10 MB raw); least recently used dropped first. */
export const MAX_CACHED_SHARDS = 64;

/** A cached shard file. */
export interface CachedShard {
  /** Path relative to the puzzle base, e.g. `shards/1500-0123456789abcdef.json` (the key). */
  file: string;
  /** sha256 of the dump the shard was built from (= `index.dataset.sha256` of its index). */
  dataset: string;
  band: number;
  rows: PuzzleRow[];
  /** Raw size of the file (bytes of the JSON text). */
  bytes: number;
  fetchedAt: number;
  usedAt: number;
}

/** Cached shard without its rows (listing). */
export type CachedShardInfo = Omit<CachedShard, 'rows'>;

const SHARDS = PUZZLE_STORES.shards;
const META = PUZZLE_STORES.meta;

/** One `meta` record. */
interface MetaRecord {
  key: string;
  value: unknown;
}

interface Backend {
  readonly kind: 'indexeddb' | 'memory';
  getShard(file: string, now: number): Promise<CachedShard | undefined>;
  putShard(s: CachedShard): Promise<void>;
  listShards(): Promise<CachedShardInfo[]>;
  deleteShards(files: readonly string[]): Promise<void>;
  getMeta(key: string): Promise<unknown>;
  putMeta(key: string, value: unknown): Promise<void>;
  clear(): Promise<void>;
}

const limits = { shards: MAX_CACHED_SHARDS };

/** Structured copy so callers can never mutate what the memory backend holds. */
const copy = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

/** The shard's metadata without its rows. */
const shardInfo = (s: CachedShard): CachedShardInfo => ({
  file: s.file,
  dataset: s.dataset,
  band: s.band,
  bytes: s.bytes,
  fetchedAt: s.fetchedAt,
  usedAt: s.usedAt,
});

// ---------------------------------------------------------------------------------------------
// In-memory backend

class MemoryBackend implements Backend {
  readonly kind = 'memory';
  private readonly shards = new Map<string, CachedShard>();
  private readonly meta = new Map<string, unknown>();

  async getShard(file: string, now: number) {
    const s = this.shards.get(file);
    if (!s) return undefined;
    s.usedAt = now;
    return copy(s);
  }
  async putShard(s: CachedShard) {
    this.shards.set(s.file, copy(s));
    if (this.shards.size > limits.shards) {
      const lru = [...this.shards.values()].sort((a, b) => a.usedAt - b.usedAt);
      for (const o of lru.slice(0, this.shards.size - limits.shards)) this.shards.delete(o.file);
    }
  }
  async listShards() {
    return [...this.shards.values()].map(shardInfo);
  }
  async deleteShards(files: readonly string[]) {
    for (const f of files) this.shards.delete(f);
  }
  async getMeta(key: string) {
    return copy(this.meta.get(key));
  }
  async putMeta(key: string, value: unknown) {
    this.meta.set(key, copy(value));
  }
  async clear() {
    this.shards.clear();
    this.meta.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// IndexedDB backend

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

class IdbBackend implements Backend {
  readonly kind = 'indexeddb';
  constructor(private readonly db: IDBDatabase) {}

  async getShard(file: string, now: number) {
    const tx = this.db.transaction(SHARDS, 'readwrite');
    const done = complete(tx);
    const os = tx.objectStore(SHARDS);
    const s = (await request(os.get(file))) as CachedShard | undefined;
    if (s) os.put({ ...s, usedAt: now });
    await done;
    return s ? { ...s, usedAt: now } : undefined;
  }
  async putShard(s: CachedShard) {
    const tx = this.db.transaction(SHARDS, 'readwrite');
    tx.objectStore(SHARDS).put(s);
    await complete(tx);
    await this.trimShards();
  }
  private async trimShards() {
    const tx = this.db.transaction(SHARDS, 'readwrite');
    const done = complete(tx);
    const os = tx.objectStore(SHARDS);
    let excess = (await request(os.count())) - limits.shards;
    if (excess > 0) {
      const cursorReq = os.index('usedAt').openCursor();
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
  async listShards() {
    // A cursor over the records, keeping only the metadata (rows can be ~10 MB in all).
    const tx = this.db.transaction(SHARDS, 'readonly');
    const done = complete(tx);
    const out: CachedShardInfo[] = [];
    const cursorReq = tx.objectStore(SHARDS).openCursor();
    await new Promise<void>((resolve, reject) => {
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (!c) return resolve();
        out.push(shardInfo(c.value as CachedShard));
        c.continue();
      };
    });
    await done;
    return out;
  }
  async deleteShards(files: readonly string[]) {
    if (files.length === 0) return;
    const tx = this.db.transaction(SHARDS, 'readwrite');
    const os = tx.objectStore(SHARDS);
    for (const f of files) os.delete(f);
    await complete(tx);
  }
  async getMeta(key: string) {
    const tx = this.db.transaction(META, 'readonly');
    const r = (await request(tx.objectStore(META).get(key))) as MetaRecord | undefined;
    return r?.value;
  }
  async putMeta(key: string, value: unknown) {
    const tx = this.db.transaction(META, 'readwrite');
    tx.objectStore(META).put({ key, value } satisfies MetaRecord);
    await complete(tx);
  }
  async clear() {
    const tx = this.db.transaction([SHARDS, META], 'readwrite');
    tx.objectStore(SHARDS).clear();
    tx.objectStore(META).clear();
    await complete(tx);
  }
}

// ---------------------------------------------------------------------------------------------
// Module state and public API

/** `undefined`: `globalThis.indexedDB` at first use; `null`: memory only. */
let factoryOverride: IDBFactory | null | undefined;
let schemaVersion = PUZZLES_DB_VERSION;
let backendPromise: Promise<Backend> | null = null;
let now: () => number = Date.now;

async function init(): Promise<Backend> {
  const factory =
    factoryOverride === undefined
      ? (globalThis as { indexedDB?: IDBFactory }).indexedDB
      : factoryOverride;
  if (factory) {
    try {
      return new IdbBackend(await openPuzzlesDb(factory, schemaVersion));
    } catch (err) {
      console.warn('Puzzle cache: IndexedDB unavailable, keeping puzzle data in memory', err);
    }
  }
  return new MemoryBackend();
}

const backend = (): Promise<Backend> => (backendPromise ??= init());

/**
 * Selects the storage (tests): an `IDBFactory` (e.g. fake-indexeddb), `null` for memory only, or
 * `undefined` for `globalThis.indexedDB`; `version` overrides the schema version, `maxShards` the
 * LRU bound, `clock` the time source. Forgets the current backend (data stays in the database).
 */
export function configurePuzzleCache(
  factory: IDBFactory | null | undefined,
  opts: { version?: number; maxShards?: number; clock?: () => number } = {},
): void {
  factoryOverride = factory;
  schemaVersion = opts.version ?? PUZZLES_DB_VERSION;
  limits.shards = opts.maxShards ?? MAX_CACHED_SHARDS;
  now = opts.clock ?? Date.now;
  backendPromise = null;
}

/** Which storage is in use. */
export async function puzzleCacheKind(): Promise<Backend['kind']> {
  return (await backend()).kind;
}

/** The cached shard `file` (and marks it as used now), or undefined. */
export async function getCachedShard(file: string): Promise<CachedShard | undefined> {
  try {
    return await (await backend()).getShard(file, now());
  } catch {
    return undefined;
  }
}

/** Stores a shard (`fetchedAt`/`usedAt` default to now) and drops the least recently used. */
export async function putCachedShard(
  shard: Omit<CachedShard, 'fetchedAt' | 'usedAt'> &
    Partial<Pick<CachedShard, 'fetchedAt' | 'usedAt'>>,
): Promise<void> {
  try {
    const t = now();
    await (
      await backend()
    ).putShard({ ...shard, fetchedAt: shard.fetchedAt ?? t, usedAt: shard.usedAt ?? t });
  } catch (err) {
    console.warn('Puzzle cache: could not store a shard', err);
  }
}

/** Metadata of every cached shard (no rows). */
export async function listCachedShards(): Promise<CachedShardInfo[]> {
  try {
    return await (await backend()).listShards();
  } catch {
    return [];
  }
}

export async function deleteCachedShards(files: readonly string[]): Promise<void> {
  try {
    await (await backend()).deleteShards(files);
  } catch (err) {
    console.warn('Puzzle cache: could not delete shards', err);
  }
}

/** A `meta` value (unvalidated: the caller parses it), or undefined. */
export async function getPuzzleMeta(key: string): Promise<unknown> {
  try {
    return await (await backend()).getMeta(key);
  } catch {
    return undefined;
  }
}

export async function putPuzzleMeta(key: string, value: unknown): Promise<void> {
  try {
    await (await backend()).putMeta(key, value);
  } catch (err) {
    console.warn('Puzzle cache: could not store meta', err);
  }
}

/** Empties the re-fetchable data (`shards`, `meta`); the stage-2 stores are not touched. */
export async function clearPuzzleCache(): Promise<void> {
  try {
    await (await backend()).clear();
  } catch (err) {
    console.warn('Puzzle cache: could not clear', err);
  }
}
