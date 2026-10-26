/**
 * The one IndexedDB database of the puzzles feature (ADR-023 §5, §9, §10): `daisychess-puzzles`,
 * shared by the shard/index cache (`cache.ts`: stores `shards`, `meta`), the game ledger
 * (`gameLedger.ts`: store `games`) and the mistake puzzles (store `mistakes`).
 *
 * Every module that opens the database goes through {@link openPuzzlesDb}, so all of them create
 * exactly the same schema in `onupgradeneeded`, whichever opens it first. A version bump
 * recreates every store (the ledger and the mistakes are then lost) — bump only together with a
 * migration here.
 *
 * Schema of version 1:
 * - `shards`   keyPath `file`,    index `usedAt`
 * - `meta`     keyPath `key`      (records `{ key, value }`, owned by `cache.ts`)
 * - `games`    keyPath `gameKey`, index `reviewedAt`
 * - `mistakes` keyPath `id`,      indexes `createdAt`, `gameKey`
 */

export const PUZZLES_DB_NAME = 'daisychess-puzzles';
export const PUZZLES_DB_VERSION = 1;

export const PUZZLE_STORES = {
  shards: 'shards',
  meta: 'meta',
  games: 'games',
  mistakes: 'mistakes',
} as const;

export type PuzzleStoreName = (typeof PUZZLE_STORES)[keyof typeof PUZZLE_STORES];

/** Drops every existing store and creates the stores of {@link PUZZLES_DB_VERSION}. */
export function upgradePuzzlesDb(db: IDBDatabase): void {
  for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
  const shards = db.createObjectStore(PUZZLE_STORES.shards, { keyPath: 'file' });
  shards.createIndex('usedAt', 'usedAt');
  db.createObjectStore(PUZZLE_STORES.meta, { keyPath: 'key' });
  const games = db.createObjectStore(PUZZLE_STORES.games, { keyPath: 'gameKey' });
  games.createIndex('reviewedAt', 'reviewedAt');
  const mistakes = db.createObjectStore(PUZZLE_STORES.mistakes, { keyPath: 'id' });
  mistakes.createIndex('createdAt', 'createdAt');
  mistakes.createIndex('gameKey', 'gameKey');
}

/**
 * Opens the database (creating/upgrading it with {@link upgradePuzzlesDb}). `version` is a test
 * seam. The connection closes itself when another tab upgrades the database. Rejects when
 * IndexedDB is unusable (private mode, blocked storage): callers fall back to memory.
 */
export function openPuzzlesDb(
  factory: IDBFactory,
  version: number = PUZZLES_DB_VERSION,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = factory.open(PUZZLES_DB_NAME, version);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    r.onupgradeneeded = () => upgradePuzzlesDb(r.result);
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'));
    r.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}
