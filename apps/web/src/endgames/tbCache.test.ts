import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { TbPosition } from '@daisychess/endgames';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPositionCache,
  configureTbCache,
  countCachedPositions,
  deleteStoredTables,
  ENDGAMES_DB_NAME,
  getCachedPosition,
  getStoredTable,
  MAX_CACHED_POSITIONS,
  putCachedPosition,
  putStoredTable,
  storedTableNames,
  tbCacheKind,
  tbKey,
  TOUCH_AFTER_MS,
  type StoredTable,
} from './tbCache';

const FEN = '8/8/8/8/8/2k5/8/KQ6 w - - 3 40';
const pos = (fen: string, dtz = 5): TbPosition => ({ fen, category: 'win', dtz, moves: [] });
const table = (name: string, n = 16): StoredTable => ({
  name,
  pack: 'rook',
  sha256: 'a'.repeat(64),
  size: n,
  bytes: new Uint8Array(n).fill(7).buffer,
  fetchedAt: 1,
});

let factory: IDBFactory;
let now = 1_000;

beforeEach(() => {
  factory = new IDBFactory();
  now = 1_000;
  configureTbCache(factory, { now: () => now });
});
afterEach(() => configureTbCache(undefined));

describe('tbKey', () => {
  it('drops the full-move number, keeps the halfmove clock', () => {
    expect(tbKey(FEN)).toBe('8/8/8/8/8/2k5/8/KQ6 w - - 3');
    expect(tbKey(' 8/8/8/8/8/2k5/8/KQ6  w - - 3 99 ')).toBe(tbKey(FEN));
    expect(tbKey('8/8/8/8/8/2k5/8/KQ6 w - - 4 40')).not.toBe(tbKey(FEN));
  });
});

describe('position cache (IndexedDB)', () => {
  it('stores and returns answers by key, with the caller FEN', async () => {
    expect(await tbCacheKind()).toBe('indexeddb');
    expect(await getCachedPosition(FEN)).toBeUndefined();
    await putCachedPosition(FEN, pos(FEN));
    const other = '8/8/8/8/8/2k5/8/KQ6 w - - 3 77';
    expect(await getCachedPosition(other)).toEqual({ ...pos(FEN), fen: other });
    expect(await countCachedPositions()).toBe(1);
    await clearPositionCache();
    expect(await countCachedPositions()).toBe(0);
  });

  it('survives a new backend (same database)', async () => {
    await putCachedPosition(FEN, pos(FEN));
    configureTbCache(factory, { now: () => now });
    expect((await getCachedPosition(FEN))?.dtz).toBe(5);
    const names = (await factory.databases()).map((d) => d.name);
    expect(names).toContain(ENDGAMES_DB_NAME);
  });

  it('drops the least recently used entries beyond the bound (to 90 %)', async () => {
    expect(MAX_CACHED_POSITIONS).toBe(20_000);
    configureTbCache(factory, { maxPositions: 10, now: () => now });
    const fen = (i: number) => `8/8/8/8/8/2k5/8/KQ6 w - - ${i} 1`;
    for (let i = 0; i < 10; i++) {
      now = 1_000 + i * 1000;
      await putCachedPosition(fen(i), pos(fen(i), i));
    }
    // A hit on the oldest refreshes it (older than TOUCH_AFTER_MS).
    now = 1_000 + 10 * 1000 + TOUCH_AFTER_MS + 1;
    expect(await getCachedPosition(fen(0))).toBeDefined();
    await new Promise((r) => setTimeout(r, 20));
    now += 1000;
    await putCachedPosition(fen(10), pos(fen(10), 10));
    expect(await countCachedPositions()).toBe(9);
    expect(await getCachedPosition(fen(0))).toBeDefined();
    expect(await getCachedPosition(fen(1))).toBeUndefined();
    expect(await getCachedPosition(fen(2))).toBeUndefined();
    expect(await getCachedPosition(fen(10))).toBeDefined();
  });

  it('a newer schema version starts empty', async () => {
    await putCachedPosition(FEN, pos(FEN));
    configureTbCache(factory, { version: 2 });
    expect(await getCachedPosition(FEN)).toBeUndefined();
  });
});

describe('tables store', () => {
  it('stores, lists (keys only), reads and deletes table files', async () => {
    expect(await storedTableNames()).toEqual([]);
    expect(await putStoredTable(table('KRvKR.rtbw'))).toBe(true);
    expect(await putStoredTable(table('KRPvKR.rtbw', 32))).toBe(true);
    expect((await storedTableNames()).sort()).toEqual(['KRPvKR.rtbw', 'KRvKR.rtbw']);
    const got = await getStoredTable('KRPvKR.rtbw');
    expect(got?.size).toBe(32);
    expect(new Uint8Array(got!.bytes)[31]).toBe(7);
    await deleteStoredTables(['KRvKR.rtbw', 'nope']);
    expect(await storedTableNames()).toEqual(['KRPvKR.rtbw']);
  });
});

describe('memory fallback and swallowed errors', () => {
  it('works without IndexedDB, and stored bytes survive a transfer of the returned copy', async () => {
    configureTbCache(null, { now: () => now });
    expect(await tbCacheKind()).toBe('memory');
    await putCachedPosition(FEN, pos(FEN));
    expect((await getCachedPosition(FEN))?.category).toBe('win');
    await putStoredTable(table('KRvKR.rtbw'));
    const a = await getStoredTable('KRvKR.rtbw');
    structuredClone(a!.bytes, { transfer: [a!.bytes] }); // detaches the copy
    expect(a!.bytes.byteLength).toBe(0);
    expect((await getStoredTable('KRvKR.rtbw'))!.bytes.byteLength).toBe(16);
  });

  it('memory LRU bound', async () => {
    configureTbCache(null, { maxPositions: 10, now: () => now });
    for (let i = 0; i < 11; i++) {
      now++;
      await putCachedPosition(`8/8/8/8/8/2k5/8/KQ6 w - - ${i} 1`, pos(FEN));
    }
    expect(await countCachedPositions()).toBe(9);
  });

  it('falls back to memory when opening fails, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = {
      open: () => {
        throw new Error('SecurityError');
      },
    } as unknown as IDBFactory;
    configureTbCache(broken);
    expect(await tbCacheKind()).toBe('memory');
    await putCachedPosition(FEN, pos(FEN));
    expect(await getCachedPosition(FEN)).toBeDefined();
    warn.mockRestore();
  });
});
