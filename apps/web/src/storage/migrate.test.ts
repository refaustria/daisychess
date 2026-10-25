import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteOldReviewDb,
  migratedKey,
  migrateStorage,
  migrateStorageKeys,
  OLD_REVIEW_DB_NAME,
  type MigratableStorage,
} from './migrate';

/** Map-backed Storage with optional failure injection. */
function fakeStorage(init: Record<string, string> = {}, failSet?: (k: string) => boolean): MigratableStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(init));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (failSet?.(k)) throw new DOMException('quota', 'QuotaExceededError');
      data.set(k, String(v));
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

describe('migratedKey', () => {
  it('maps chesslab.* to daisychess.* and ignores other keys', () => {
    expect(migratedKey('chesslab.settings')).toBe('daisychess.settings');
    expect(migratedKey('chesslab.room.ab12cd')).toBe('daisychess.room.ab12cd');
    expect(migratedKey('chesslab.lichess.pkce')).toBe('daisychess.lichess.pkce');
    expect(migratedKey('daisychess.theme')).toBeNull();
    expect(migratedKey('chesslabsettings')).toBeNull();
    expect(migratedKey('other')).toBeNull();
  });
});

describe('migrateStorageKeys', () => {
  it('moves every old key, keeping values (incl. the lichess token) and unrelated keys', () => {
    const token = JSON.stringify({ token: 'lio_secret', username: 'Alice', scopes: [] });
    const s = fakeStorage({
      'chesslab.theme': 'dark',
      'chesslab.lichess': token,
      'chesslab.room.ab12cd': '{"seat":"w"}',
      'chesslab.nick': 'Bob',
      'chesslab.trainer': '{}',
      'chesslab.play': '{}',
      'chesslab.settings': '{"premoves":"queue"}',
      unrelated: 'x',
    });
    const moved = migrateStorageKeys(s);
    expect(moved).toHaveLength(7);
    expect(Object.fromEntries(s.data)).toEqual({
      'daisychess.theme': 'dark',
      'daisychess.lichess': token,
      'daisychess.room.ab12cd': '{"seat":"w"}',
      'daisychess.nick': 'Bob',
      'daisychess.trainer': '{}',
      'daisychess.play': '{}',
      'daisychess.settings': '{"premoves":"queue"}',
      unrelated: 'x',
    });
  });

  it('keeps an existing new value and still removes the old key', () => {
    const s = fakeStorage({ 'chesslab.theme': 'dark', 'daisychess.theme': 'light' });
    migrateStorageKeys(s);
    expect(Object.fromEntries(s.data)).toEqual({ 'daisychess.theme': 'light' });
  });

  it('is idempotent', () => {
    const s = fakeStorage({ 'chesslab.nick': 'Bob' });
    expect(migrateStorageKeys(s)).toEqual(['chesslab.nick']);
    expect(migrateStorageKeys(s)).toEqual([]);
    expect(Object.fromEntries(s.data)).toEqual({ 'daisychess.nick': 'Bob' });
  });

  it('keeps the old key when the copy fails, and migrates the others', () => {
    const s = fakeStorage(
      { 'chesslab.analysis': 'big', 'chesslab.nick': 'Bob' },
      (k) => k === 'daisychess.analysis',
    );
    expect(migrateStorageKeys(s)).toEqual(['chesslab.nick']);
    expect(Object.fromEntries(s.data)).toEqual({ 'chesslab.analysis': 'big', 'daisychess.nick': 'Bob' });
  });
});

describe('deleteOldReviewDb', () => {
  type Req = { onsuccess: (() => void) | null; onerror: (() => void) | null; onblocked: (() => void) | null };
  function factory(outcome: 'success' | 'error' | 'blocked' | 'throw') {
    const deleteDatabase = vi.fn<(name: string) => IDBOpenDBRequest>(() => {
      if (outcome === 'throw') throw new Error('SecurityError');
      const req: Req = { onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (outcome === 'success') req.onsuccess?.();
        else if (outcome === 'error') req.onerror?.();
        else req.onblocked?.();
      });
      return req as unknown as IDBOpenDBRequest;
    });
    return { deleteDatabase };
  }

  it('deletes the old database by name', async () => {
    const f = factory('success');
    await expect(deleteOldReviewDb(f)).resolves.toBe(true);
    expect(f.deleteDatabase).toHaveBeenCalledWith(OLD_REVIEW_DB_NAME);
  });

  it('resolves false without IndexedDB, on error, when blocked and when it throws', async () => {
    await expect(deleteOldReviewDb(undefined)).resolves.toBe(false);
    await expect(deleteOldReviewDb(factory('error'))).resolves.toBe(false);
    await expect(deleteOldReviewDb(factory('blocked'))).resolves.toBe(false);
    await expect(deleteOldReviewDb(factory('throw'))).resolves.toBe(false);
  });
});

describe('migrateStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('migrates localStorage and sessionStorage and deletes the old review db', () => {
    localStorage.setItem('chesslab.lichess', '{"token":"lio_x"}');
    sessionStorage.setItem('chesslab.lichess.pkce', '{"state":"s"}');
    const deleteDatabase = vi.fn(() => ({}) as IDBOpenDBRequest);
    vi.stubGlobal('indexedDB', { deleteDatabase });
    migrateStorage();
    expect(localStorage.getItem('chesslab.lichess')).toBeNull();
    expect(localStorage.getItem('daisychess.lichess')).toBe('{"token":"lio_x"}');
    expect(sessionStorage.getItem('daisychess.lichess.pkce')).toBe('{"state":"s"}');
    expect(deleteDatabase).toHaveBeenCalledWith('chesslab-reviews');
  });

  it('does not throw when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('sessionStorage', undefined);
    vi.stubGlobal('indexedDB', undefined);
    expect(() => migrateStorage()).not.toThrow();
  });
});
