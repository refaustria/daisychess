/**
 * Persistent cache of Maia review hints (M23-3): one record per `gameKey + ply + rating` in
 * IndexedDB (`daisychess-maia-hints`, separate from the review cache and its record format),
 * bounded to {@link MAX_STORED_HINTS} (least recently used dropped first), with an in-memory
 * fallback when IndexedDB is unavailable. Same pattern as `review/reviewCache.ts`: every public
 * function swallows storage errors (reads return nothing, writes are dropped).
 */
import type { MaiaHint } from './hints';

export const MAIA_HINT_DB_NAME = 'daisychess-maia-hints';
/** Schema version: bumping it drops all stored hints of older versions. */
export const MAIA_HINT_CACHE_VERSION = 1;
export const MAX_STORED_HINTS = 20_000;

export const hintId = (gameKey: string, ply: number, rating: number): string =>
  `${gameKey}|${ply}|${rating}`;

export interface StoredHint {
  id: string;
  hint: MaiaHint;
  usedAt: number;
  version: number;
}

interface Backend {
  readonly kind: 'indexeddb' | 'memory';
  get(ids: readonly string[]): Promise<StoredHint[]>;
  put(entries: readonly StoredHint[]): Promise<void>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

const limits = { hints: MAX_STORED_HINTS };

class MemoryBackend implements Backend {
  readonly kind = 'memory';
  private readonly hints = new Map<string, StoredHint>();
  async get(ids: readonly string[]) {
    return ids.flatMap((id) => {
      const h = this.hints.get(id);
      return h ? [h] : [];
    });
  }
  async put(entries: readonly StoredHint[]) {
    for (const e of entries) this.hints.set(e.id, e);
    if (this.hints.size > limits.hints) {
      const target = Math.floor(limits.hints * 0.9);
      const lru = [...this.hints.values()].sort((a, b) => a.usedAt - b.usedAt);
      for (const o of lru.slice(0, this.hints.size - target)) this.hints.delete(o.id);
    }
  }
  async count() {
    return this.hints.size;
  }
  async clear() {
    this.hints.clear();
  }
}

const HINTS = 'hints';

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
      r = factory.open(MAIA_HINT_DB_NAME, schemaVersion);
    } catch (err) {
      reject(err);
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      const os = db.createObjectStore(HINTS, { keyPath: 'id' });
      os.createIndex('usedAt', 'usedAt');
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

  async get(ids: readonly string[]) {
    const tx = this.db.transaction(HINTS, 'readonly');
    const os = tx.objectStore(HINTS);
    const found = await Promise.all(
      [...new Set(ids)].map((id) => request(os.get(id)) as Promise<StoredHint | undefined>),
    );
    return found.filter((h): h is StoredHint => h !== undefined && h.version === schemaVersion);
  }
  async put(entries: readonly StoredHint[]) {
    if (entries.length === 0) return;
    const tx = this.db.transaction(HINTS, 'readwrite');
    const os = tx.objectStore(HINTS);
    for (const e of entries) os.put(e);
    await complete(tx);
    await this.trim();
  }
  private async trim() {
    const tx = this.db.transaction(HINTS, 'readwrite');
    const done = complete(tx);
    const os = tx.objectStore(HINTS);
    const count = await request(os.count());
    if (count > limits.hints) {
      let excess = count - Math.floor(limits.hints * 0.9);
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
  async count() {
    const tx = this.db.transaction(HINTS, 'readonly');
    return request(tx.objectStore(HINTS).count());
  }
  async clear() {
    const tx = this.db.transaction(HINTS, 'readwrite');
    tx.objectStore(HINTS).clear();
    await complete(tx);
  }
}

/** `undefined`: `globalThis.indexedDB` at first use; `null`: memory only. */
let factoryOverride: IDBFactory | null | undefined;
let schemaVersion = MAIA_HINT_CACHE_VERSION;
let backendPromise: Promise<Backend> | null = null;

async function init(): Promise<Backend> {
  const factory =
    factoryOverride === undefined
      ? (globalThis as { indexedDB?: IDBFactory }).indexedDB
      : factoryOverride;
  if (factory) {
    try {
      return new IdbBackend(await openDb(factory));
    } catch (err) {
      console.warn('Maia hint cache: IndexedDB unavailable, keeping hints in memory', err);
    }
  }
  return new MemoryBackend();
}

const backend = (): Promise<Backend> => (backendPromise ??= init());

/**
 * Selects the storage (tests): an `IDBFactory`, `null` for memory only, `undefined` for
 * `globalThis.indexedDB`; `version` / `maxHints` override the schema version and the bound.
 */
export function configureHintCache(
  factory: IDBFactory | null | undefined,
  opts: { version?: number; maxHints?: number } = {},
): void {
  factoryOverride = factory;
  schemaVersion = opts.version ?? MAIA_HINT_CACHE_VERSION;
  limits.hints = opts.maxHints ?? MAX_STORED_HINTS;
  backendPromise = null;
}

export async function hintCacheKind(): Promise<Backend['kind']> {
  return (await backend()).kind;
}

/** The stored hints among `ids` (missing ones are left out). */
export async function getStoredHints(ids: readonly string[]): Promise<StoredHint[]> {
  if (ids.length === 0) return [];
  try {
    return await (await backend()).get(ids);
  } catch {
    return [];
  }
}

export async function putStoredHints(
  entries: ReadonlyArray<{ id: string; hint: MaiaHint }>,
  now: number = Date.now(),
): Promise<void> {
  try {
    await (
      await backend()
    ).put(entries.map((e) => ({ id: e.id, hint: e.hint, usedAt: now, version: schemaVersion })));
  } catch (err) {
    console.warn('Maia hint cache: could not store hints', err);
  }
}

export async function countStoredHints(): Promise<number> {
  try {
    return await (await backend()).count();
  } catch {
    return 0;
  }
}

export async function clearHintCache(): Promise<void> {
  try {
    await (await backend()).clear();
  } catch (err) {
    console.warn('Maia hint cache: could not clear', err);
  }
}
