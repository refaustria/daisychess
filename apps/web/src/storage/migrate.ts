/**
 * One-time storage migration for the rename ChessLab → DaisyChess (ADR-018).
 *
 * Every `chesslab.*` key in localStorage and sessionStorage is copied to its `daisychess.*`
 * counterpart (only when the new key is absent, so a newer value always wins) and the old key is
 * removed. That covers all persisted state: settings, theme, analysis, trainer, play setup, nick,
 * `chesslab.room.<id>` seats, the lichess login (`chesslab.lichess`, so the token survives) and
 * the in-flight PKCE round trip. The review cache moved to a new IndexedDB database; the old one
 * is deleted best-effort (cached reviews are recomputable, ADR-016).
 *
 * Runs before any store reads storage: `runMigration.ts` is imported first in main.tsx.
 * Idempotent and never throws (private mode, blocked storage, quota).
 */

export const OLD_KEY_PREFIX = 'chesslab.';
export const NEW_KEY_PREFIX = 'daisychess.';
export const OLD_REVIEW_DB_NAME = 'chesslab-reviews';

/** The subset of the Web Storage API the migration needs (localStorage, sessionStorage, fakes). */
export type MigratableStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

/** The new name for an old key, or `null` when `key` is not a `chesslab.*` key. */
export function migratedKey(key: string): string | null {
  return key.startsWith(OLD_KEY_PREFIX) ? NEW_KEY_PREFIX + key.slice(OLD_KEY_PREFIX.length) : null;
}

/**
 * Moves every `chesslab.*` key of `storage` to `daisychess.*`; returns the old keys handled.
 * An existing `daisychess.*` value is kept and the old key is still removed. An old key whose
 * copy fails (quota) is kept, so the next start retries.
 */
export function migrateStorageKeys(storage: MigratableStorage): string[] {
  const oldKeys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null && migratedKey(k) !== null) oldKeys.push(k);
  }
  const moved: string[] = [];
  for (const oldKey of oldKeys) {
    const newKey = migratedKey(oldKey) as string;
    try {
      const value = storage.getItem(oldKey);
      if (value === null) continue;
      if (storage.getItem(newKey) === null) storage.setItem(newKey, value);
      storage.removeItem(oldKey);
      moved.push(oldKey);
    } catch {
      // Quota or blocked storage: leave the old key for the next start.
    }
  }
  return moved;
}

/** Best-effort removal of the old review cache database; resolves `false` when unavailable. */
export function deleteOldReviewDb(factory: Pick<IDBFactory, 'deleteDatabase'> | undefined): Promise<boolean> {
  if (!factory) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const req = factory.deleteDatabase(OLD_REVIEW_DB_NAME);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
      // Another tab still has it open: the deletion completes once that tab closes it.
      req.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** Safe accessor: `globalThis[name]` can throw (blocked site data) or be missing. */
function storageOf(name: 'localStorage' | 'sessionStorage'): MigratableStorage | undefined {
  try {
    return (globalThis as Partial<Record<typeof name, Storage>>)[name] ?? undefined;
  } catch {
    return undefined;
  }
}

/** Runs the whole migration on the real browser storages. */
export function migrateStorage(): void {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const s = storageOf(name);
    if (!s) continue;
    try {
      migrateStorageKeys(s);
    } catch {
      // Enumeration failed: nothing to migrate in this storage.
    }
  }
  let idb: IDBFactory | undefined;
  try {
    idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  } catch {
    idb = undefined;
  }
  void deleteOldReviewDb(idb);
}
