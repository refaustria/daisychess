import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHintCache,
  configureHintCache,
  countStoredHints,
  getStoredHints,
  hintCacheKind,
  hintId,
  MAX_STORED_HINTS,
  putStoredHints,
} from './hintCache';
import type { MaiaHint } from './hints';

const hint = (ply: number, rating = 1500): MaiaHint => ({
  ply,
  rating,
  top: [{ uci: 'e2e4', san: 'e4', p: 0.5 }],
  playedIsTop: false,
  entries: 1,
});

afterEach(() => configureHintCache(undefined));

it('holds 20 000 hints (the Elo estimate stores up to 540 per game, ADR-024)', () => {
  expect(MAX_STORED_HINTS).toBe(20_000);
});

const BACKENDS: ReadonlyArray<readonly ['indexeddb' | 'memory', () => IDBFactory | null]> = [
  ['indexeddb', () => new IDBFactory()],
  ['memory', () => null],
];

describe.each(BACKENDS)('hint cache (%s)', (kind, factory) => {
  it('stores and reads hints keyed by game, ply and rating', async () => {
    configureHintCache(factory());
    expect(await hintCacheKind()).toBe(kind);
    await putStoredHints([
      { id: hintId('g', 6, 1500), hint: hint(6) },
      { id: hintId('g', 6, 1900), hint: hint(6, 1900) },
    ]);
    const got = await getStoredHints([hintId('g', 6, 1500), hintId('g', 8, 1500)]);
    expect(got.map((h) => h.hint)).toEqual([hint(6)]);
    expect((await getStoredHints([hintId('g', 6, 1900)]))[0]!.hint.rating).toBe(1900);
    expect(await getStoredHints([])).toEqual([]);
    await clearHintCache();
    expect(await countStoredHints()).toBe(0);
  });

  it('is bounded: the least recently stored hints are dropped first', async () => {
    configureHintCache(factory(), { maxHints: 10 });
    for (let i = 0; i < 12; i++) await putStoredHints([{ id: `k${i}`, hint: hint(i) }], 1000 + i);
    const n = await countStoredHints();
    expect(n).toBeLessThanOrEqual(10);
    expect(await getStoredHints(['k0'])).toEqual([]);
    expect((await getStoredHints(['k11'])).length).toBe(1);
  });
});

describe('hint cache versions', () => {
  it('a new schema version drops older hints', async () => {
    const idb = new IDBFactory();
    configureHintCache(idb, { version: 1 });
    await putStoredHints([{ id: 'a', hint: hint(1) }]);
    configureHintCache(idb, { version: 2 });
    expect(await getStoredHints(['a'])).toEqual([]);
  });
});
