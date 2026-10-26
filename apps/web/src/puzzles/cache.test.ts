import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { PuzzleRow } from '@daisychess/puzzles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPuzzleCache,
  configurePuzzleCache,
  deleteCachedShards,
  getCachedShard,
  getPuzzleMeta,
  listCachedShards,
  MAX_CACHED_SHARDS,
  puzzleCacheKind,
  putCachedShard,
  putPuzzleMeta,
} from './cache';
import { openPuzzlesDb, PUZZLE_STORES } from './puzzlesDb';

const FEN = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
const row = (id: string): PuzzleRow => [id, FEN, 'd1d8 g8h8', 1500, 75, [0], [], ''];
const file = (n: number): string => `shards/1500-${n.toString(16).padStart(16, '0')}.json`;
const shard = (n: number, over: { usedAt?: number } = {}) => ({
  file: file(n),
  dataset: 'ds1',
  band: 1500,
  rows: [row(`p${n}`)],
  bytes: 100 + n,
  ...over,
});

afterEach(() => {
  configurePuzzleCache(undefined);
  vi.restoreAllMocks();
});

const backends: Array<[string, () => IDBFactory | null]> = [
  ['indexeddb', () => new IDBFactory()],
  ['memory', () => null],
];

describe.each(backends)('puzzle cache (%s)', (kind, factory) => {
  const setup = (opts: { maxShards?: number; clock?: () => number } = {}) =>
    configurePuzzleCache(factory(), opts);

  it('uses the expected backend', async () => {
    setup();
    expect(await puzzleCacheKind()).toBe(kind);
  });

  it('stores and reads a shard, stamping fetchedAt/usedAt', async () => {
    let t = 1000;
    setup({ clock: () => t });
    await putCachedShard(shard(1));
    t = 2000;
    const got = await getCachedShard(file(1));
    expect(got).toMatchObject({ file: file(1), dataset: 'ds1', band: 1500, fetchedAt: 1000 });
    expect(got?.usedAt).toBe(2000);
    expect(got?.rows).toEqual([row('p1')]);
    expect(await getCachedShard(file(2))).toBeUndefined();
  });

  it('lists shards without rows', async () => {
    setup();
    await putCachedShard(shard(1));
    await putCachedShard(shard(2));
    const list = await listCachedShards();
    expect(list.map((s) => s.file).sort()).toEqual([file(1), file(2)]);
    expect(list.every((s) => !('rows' in s))).toBe(true);
    expect(list.find((s) => s.file === file(2))?.bytes).toBe(102);
  });

  it('drops the least recently used shards beyond the bound; a read refreshes a shard', async () => {
    let t = 0;
    setup({ maxShards: 3, clock: () => ++t });
    for (const n of [1, 2, 3]) await putCachedShard(shard(n));
    await getCachedShard(file(1)); // 1 is now the most recently used
    await putCachedShard(shard(4));
    const files = (await listCachedShards()).map((s) => s.file).sort();
    expect(files).toEqual([file(1), file(3), file(4)]);
  });

  it('deletes shards and round-trips meta values', async () => {
    setup();
    await putCachedShard(shard(1));
    await putCachedShard(shard(2));
    await deleteCachedShards([file(1)]);
    expect((await listCachedShards()).map((s) => s.file)).toEqual([file(2)]);
    expect(await getPuzzleMeta('index')).toBeUndefined();
    await putPuzzleMeta('index', { a: [1, 2], fetchedAt: 5 });
    expect(await getPuzzleMeta('index')).toEqual({ a: [1, 2], fetchedAt: 5 });
  });

  it('a returned shard is a copy', async () => {
    setup();
    await putCachedShard(shard(1));
    const a = await getCachedShard(file(1));
    a!.rows.length = 0;
    expect((await getCachedShard(file(1)))?.rows).toHaveLength(1);
  });

  it('clears shards and meta', async () => {
    setup();
    await putCachedShard(shard(1));
    await putPuzzleMeta('index', 1);
    await clearPuzzleCache();
    expect(await listCachedShards()).toEqual([]);
    expect(await getPuzzleMeta('index')).toBeUndefined();
  });
});

describe('puzzle cache robustness', () => {
  it('falls back to memory when IndexedDB cannot be opened', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = {
      open: () => {
        throw new Error('blocked');
      },
    } as unknown as IDBFactory;
    configurePuzzleCache(broken);
    expect(await puzzleCacheKind()).toBe('memory');
    await putCachedShard(shard(1));
    expect((await getCachedShard(file(1)))?.file).toBe(file(1));
  });

  it('swallows storage errors after opening', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const factory = new IDBFactory();
    configurePuzzleCache(factory);
    await putCachedShard(shard(1));
    // Another tab upgrades the database: this connection closes itself and every call fails.
    const db = await openPuzzlesDb(factory, 2);
    db.close();
    await expect(getCachedShard(file(1))).resolves.toBeUndefined();
    await expect(listCachedShards()).resolves.toEqual([]);
    await expect(getPuzzleMeta('x')).resolves.toBeUndefined();
    await expect(putCachedShard(shard(2))).resolves.toBeUndefined();
    await expect(putPuzzleMeta('x', 1)).resolves.toBeUndefined();
    await expect(deleteCachedShards([file(1)])).resolves.toBeUndefined();
    await expect(clearPuzzleCache()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('shares the database schema with the ledger (stores of puzzlesDb)', async () => {
    const factory = new IDBFactory();
    configurePuzzleCache(factory);
    await putCachedShard(shard(1));
    const db = await openPuzzlesDb(factory);
    expect(Array.from(db.objectStoreNames).sort()).toEqual(Object.values(PUZZLE_STORES).sort());
    db.close();
  });

  it('bounds the default LRU at 64 shards', () => {
    expect(MAX_CACHED_SHARDS).toBe(64);
  });
});
