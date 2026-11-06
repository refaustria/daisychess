/**
 * Endgame storage (ADR-025 §2, §8): IndexedDB `daisychess-endgames` v1 with
 *
 * - `tb`: normalised tablebase answers of the lichess API per position (key {@link tbKey}: the
 *   FEN without the full-move number), at most {@link MAX_CACHED_POSITIONS} entries, least
 *   recently used dropped first;
 * - `tables`: downloaded Syzygy files of the opt-in packs (`{name, pack, sha256, size, bytes,
 *   fetchedAt}`), verified against the manifest before they are stored and again when loaded.
 *
 * In-memory fallback when IndexedDB is unavailable (private mode, blocked storage, tests), and
 * every public function swallows storage errors exactly like `review/reviewCache.ts`: reads then
 * return nothing, writes are dropped (a failing cache never fails a lookup).
 */
import type { TablePack, TbPosition } from '@daisychess/endgames';

export const ENDGAMES_DB_NAME = 'daisychess-endgames';
/** Schema version: bumping it drops all stored data of older versions. */
export const ENDGAMES_DB_VERSION = 1;
export const MAX_CACHED_POSITIONS = 20_000;
/** A cache hit refreshes `usedAt` only when the stored value is older than this (fewer writes). */
export const TOUCH_AFTER_MS = 60_000;

/** Cache key of a position: piece placement, side, castling, en passant and halfmove clock. */
export function tbKey(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 5).join(' ');
}

export interface CachedPosition {
  key: string;
  pos: TbPosition;
  usedAt: number;
}

export interface StoredTable {
  /** File name, e.g. `KRPvKR.rtbw`. */
  name: string;
  pack: TablePack;
  sha256: string;
  size: number;
  bytes: ArrayBuffer;
  fetchedAt: number;
}

interface Backend {
  readonly kind: 'indexeddb' | 'memory';
  getPosition(key: string): Promise<CachedPosition | undefined>;
  putPosition(entry: CachedPosition): Promise<void>;
  countPositions(): Promise<number>;
  clearPositions(): Promise<void>;
  getTable(name: string): Promise<StoredTable | undefined>;
  putTable(t: StoredTable): Promise<void>;
  deleteTables(names: readonly string[]): Promise<void>;
  tableNames(): Promise<string[]>;
}

const limits = { positions: MAX_CACHED_POSITIONS };

// ---------------------------------------------------------------------------------------------
// In-memory backend

class MemoryBackend implements Backend {
  readonly kind = 'memory';
  private readonly positions = new Map<string, CachedPosition>();
  private readonly tables = new Map<string, StoredTable>();

  async getPosition(key: string) {
    return this.positions.get(key);
  }
  async putPosition(entry: CachedPosition) {
    this.positions.set(entry.key, entry);
    if (this.positions.size > limits.positions) {
      const target = Math.floor(limits.positions * 0.9);
      const lru = [...this.positions.values()].sort((a, b) => a.usedAt - b.usedAt);
      for (const o of lru.slice(0, this.positions.size - target)) this.positions.delete(o.key);
    }
  }
  async countPositions() {
    return this.positions.size;
  }
  async clearPositions() {
    this.positions.clear();
  }
  async getTable(name: string) {
    // A copy, like a structured clone from IndexedDB: callers transfer the bytes to the Worker.
    const t = this.tables.get(name);
    return t ? { ...t, bytes: t.bytes.slice(0) } : undefined;
  }
  async putTable(t: StoredTable) {
    this.tables.set(t.name, t);
  }
  async deleteTables(names: readonly string[]) {
    for (const n of names) this.tables.delete(n);
  }
  async tableNames() {
    return [...this.tables.keys()];
  }
}

// ---------------------------------------------------------------------------------------------
// IndexedDB backend

const TB = 'tb';
const TABLES = 'tables';

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

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = factory.open(ENDGAMES_DB_NAME, schemaVersion);
    } catch (err) {
      reject(err);
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      const tb = db.createObjectStore(TB, { keyPath: 'key' });
      tb.createIndex('usedAt', 'usedAt');
      db.createObjectStore(TABLES, { keyPath: 'name' });
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'));
    r.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

class IdbBackend implements Backend {
  readonly kind = 'indexeddb';
  constructor(private readonly db: IDBDatabase) {}

  async getPosition(key: string) {
    const tx = this.db.transaction(TB, 'readonly');
    return (await request(tx.objectStore(TB).get(key))) as CachedPosition | undefined;
  }
  async putPosition(entry: CachedPosition) {
    const tx = this.db.transaction(TB, 'readwrite');
    const done = complete(tx);
    const os = tx.objectStore(TB);
    os.put(entry);
    const count = await request(os.count());
    if (count > limits.positions) {
      let excess = count - Math.floor(limits.positions * 0.9);
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
  async countPositions() {
    const tx = this.db.transaction(TB, 'readonly');
    return request(tx.objectStore(TB).count());
  }
  async clearPositions() {
    const tx = this.db.transaction(TB, 'readwrite');
    tx.objectStore(TB).clear();
    await complete(tx);
  }
  async getTable(name: string) {
    const tx = this.db.transaction(TABLES, 'readonly');
    return (await request(tx.objectStore(TABLES).get(name))) as StoredTable | undefined;
  }
  async putTable(t: StoredTable) {
    const tx = this.db.transaction(TABLES, 'readwrite');
    tx.objectStore(TABLES).put(t);
    await complete(tx);
  }
  async deleteTables(names: readonly string[]) {
    if (names.length === 0) return;
    const tx = this.db.transaction(TABLES, 'readwrite');
    const os = tx.objectStore(TABLES);
    for (const n of names) os.delete(n);
    await complete(tx);
  }
  async tableNames() {
    // Keys only: the values hold megabytes of table bytes.
    const tx = this.db.transaction(TABLES, 'readonly');
    return (await request(tx.objectStore(TABLES).getAllKeys())).map(String);
  }
}

// ---------------------------------------------------------------------------------------------
// Module state and public API

let factoryOverride: IDBFactory | null | undefined;
let schemaVersion = ENDGAMES_DB_VERSION;
let backendPromise: Promise<Backend> | null = null;
let clock: () => number = Date.now;

async function init(): Promise<Backend> {
  const factory =
    factoryOverride === undefined
      ? (globalThis as { indexedDB?: IDBFactory }).indexedDB
      : factoryOverride;
  if (factory) {
    try {
      return new IdbBackend(await openDb(factory));
    } catch (err) {
      console.warn('Endgame cache: IndexedDB unavailable, keeping data in memory', err);
    }
  }
  return new MemoryBackend();
}

const backend = (): Promise<Backend> => (backendPromise ??= init());

/**
 * Selects the storage (tests): an `IDBFactory` (fake-indexeddb), `null` for memory only, or
 * `undefined` for `globalThis.indexedDB`; `maxPositions` lowers the LRU bound, `now` the clock.
 * Forgets the current backend (data stays in the database).
 */
export function configureTbCache(
  factory: IDBFactory | null | undefined,
  opts: { version?: number; maxPositions?: number; now?: () => number } = {},
): void {
  factoryOverride = factory;
  schemaVersion = opts.version ?? ENDGAMES_DB_VERSION;
  limits.positions = opts.maxPositions ?? MAX_CACHED_POSITIONS;
  clock = opts.now ?? Date.now;
  backendPromise = null;
}

/** Which storage is in use. */
export async function tbCacheKind(): Promise<Backend['kind']> {
  return (await backend()).kind;
}

/** The cached answer for `fen` (same position and halfmove clock), refreshing its LRU stamp. */
export async function getCachedPosition(fen: string): Promise<TbPosition | undefined> {
  try {
    const b = await backend();
    const key = tbKey(fen);
    const hit = await b.getPosition(key);
    if (!hit) return undefined;
    const t = clock();
    if (t - hit.usedAt > TOUCH_AFTER_MS) {
      void b.putPosition({ ...hit, usedAt: t }).catch(() => undefined);
    }
    return { ...hit.pos, fen };
  } catch {
    return undefined;
  }
}

export async function putCachedPosition(fen: string, pos: TbPosition): Promise<void> {
  try {
    await (await backend()).putPosition({ key: tbKey(fen), pos, usedAt: clock() });
  } catch (err) {
    console.warn('Endgame cache: could not store a position', err);
  }
}

export async function countCachedPositions(): Promise<number> {
  try {
    return await (await backend()).countPositions();
  } catch {
    return 0;
  }
}

export async function clearPositionCache(): Promise<void> {
  try {
    await (await backend()).clearPositions();
  } catch (err) {
    console.warn('Endgame cache: could not clear', err);
  }
}

export async function getStoredTable(name: string): Promise<StoredTable | undefined> {
  try {
    return await (await backend()).getTable(name);
  } catch {
    return undefined;
  }
}

/** Stores a verified table file. False when storage failed (the download is then lost). */
export async function putStoredTable(t: StoredTable): Promise<boolean> {
  try {
    await (await backend()).putTable(t);
    return true;
  } catch (err) {
    console.warn('Endgame cache: could not store a table', err);
    return false;
  }
}

export async function deleteStoredTables(names: readonly string[]): Promise<void> {
  try {
    await (await backend()).deleteTables(names);
  } catch (err) {
    console.warn('Endgame cache: could not delete tables', err);
  }
}

/** File names of the stored tables (no bytes are read). */
export async function storedTableNames(): Promise<string[]> {
  try {
    return await (await backend()).tableNames();
  } catch {
    return [];
  }
}
