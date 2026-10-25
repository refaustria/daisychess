import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureReview, ITALIAN, SCHOLAR, START_FEN } from '../../test/review-fixtures.js';
import { EVICTION_TARGET, ReviewStore, loadSqlite } from './ReviewStore.js';
import type { PoolLogger } from '../engines/EnginePool.js';

const sqlite = await loadSqlite();
const silent: PoolLogger = { info() {}, warn() {}, error() {}, debug() {} };

let dir: string;
let store: ReviewStore;

const open = (maxBytes = 50_000_000) =>
  ReviewStore.open({ path: path.join(dir, 'reviews.sqlite'), maxBytes }, silent);

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

describe.skipIf(!sqlite)('ReviewStore (SQLite)', () => {
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-reviews-'));
    store = await open();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file, stores and returns a review, and counts bytes', () => {
    expect(store.stats()).toEqual({ reviews: 0, positions: 0, bytes: 0, maxBytes: 50_000_000 });
    const put = fixtureReview(SCHOLAR, 'fast');
    expect(store.putReview(put, 1_000)).toBe('stored');
    const row = store.getReview(put.gameKey, 2_000);
    expect(row).toMatchObject({
      gameKey: put.gameKey,
      preset: 'fast',
      startFen: START_FEN,
      moves: SCHOLAR,
      createdAt: 1_000,
    });
    expect(row?.record).toEqual(put.record);
    const s = store.stats();
    expect(s.reviews).toBe(1);
    expect(s.bytes).toBeGreaterThan(200);
    expect(store.getReview('0'.repeat(64))).toBeUndefined();
  });

  it('keeps the stronger preset: deep is never replaced by fast, fast is replaced by deep', () => {
    const fast = fixtureReview(SCHOLAR, 'fast');
    const deep = fixtureReview(SCHOLAR, 'deep');
    expect(store.putReview(fast, 1)).toBe('stored');
    expect(store.putReview(deep, 2)).toBe('stored');
    expect(store.getReview(fast.gameKey)?.preset).toBe('deep');
    expect(store.putReview(fast, 3)).toBe('superseded');
    expect(store.getReview(fast.gameKey)).toMatchObject({ preset: 'deep', createdAt: 2 });
    // The same preset replaces (a newer run).
    expect(store.putReview(deep, 4)).toBe('stored');
    expect(store.getReview(fast.gameKey)?.createdAt).toBe(4);
    expect(store.stats().reviews).toBe(1);
  });

  it('stores and returns positions per search budget', () => {
    const r1 = { eval: { cp: 20 }, bestMove: 'e2e4', pv: ['e2e4', 'e7e5'], depth: 22 };
    const r2 = { eval: { mate: -2 }, depth: 18 };
    expect(store.putPositions('mt:300', [{ fen: START_FEN, result: r1 }, { fen: AFTER_E4, result: r2 }])).toBe(2);
    expect([...store.getPositions('mt:300', [START_FEN, AFTER_E4, 'nope'])]).toEqual([
      [START_FEN, r1],
      [AFTER_E4, r2],
    ]);
    expect(store.getPositions('d:18', [START_FEN]).size).toBe(0);
    // Replacing keeps the byte total consistent.
    const before = store.stats().bytes;
    store.putPositions('mt:300', [{ fen: START_FEN, result: r1 }]);
    expect(store.stats()).toMatchObject({ positions: 2, bytes: before });
  });

  it('survives reopening (WAL, persisted) and recomputes the byte total', async () => {
    const put = fixtureReview(ITALIAN, 'deep');
    store.putReview(put);
    store.putPositions('d:18', [{ fen: START_FEN, result: { eval: { cp: 0 } } }]);
    const stats = store.stats();
    store.close();
    store = await open();
    expect(store.stats()).toEqual(stats);
    expect(store.getReview(put.gameKey)?.record).toEqual(put.record);
  });

  it('evicts least recently used rows above maxBytes, positions first, down to 90 %', async () => {
    store.close();
    const maxBytes = 6_000;
    store = await open(maxBytes);
    const review = fixtureReview(SCHOLAR, 'fast');
    store.putReview(review, 1_000);
    const reviewBytes = store.stats().bytes;
    expect(reviewBytes).toBeLessThan(maxBytes / 2);
    // Fill with positions, oldest first (distinct FENs via the halfmove counter).
    const fens: string[] = [];
    for (let i = 0; i < 200; i++) {
      fens.push(`rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - ${i} 1`);
    }
    for (const [i, fen] of fens.entries()) {
      store.putPositions('mt:300', [{ fen, result: { eval: { cp: i }, depth: 20 } }], 2_000 + i);
    }
    const s = store.stats();
    // Never above the cap; each eviction goes down to the target, later puts fill up again.
    expect(s.bytes).toBeLessThanOrEqual(maxBytes);
    expect(s.positions).toBeLessThan(200);
    const last = fens[199]!;
    store.putPositions('mt:300', [{ fen: `${last}0`, result: { eval: { cp: 1 }, depth: 20 } }], 9_000);
    if (store.stats().bytes < s.bytes) {
      expect(store.stats().bytes).toBeLessThanOrEqual(Math.floor(maxBytes * EVICTION_TARGET));
    }
    // The review (older than every position) is still there: positions go first.
    expect(s.reviews).toBe(1);
    expect(store.getReview(review.gameKey, 2_000)).toBeDefined();
    // The oldest positions are gone, the newest kept.
    expect(store.getPositions('mt:300', [fens[0]!]).size).toBe(0);
    expect(store.getPositions('mt:300', [fens[199]!]).size).toBe(1);
  });

  it('evicts reviews (least recently used first) once no positions are left', async () => {
    store.close();
    const one = fixtureReview(SCHOLAR, 'fast');
    store = await open(10_000_000);
    store.putReview(one, 1);
    const bytesPerReview = store.stats().bytes;
    store.close();
    store = await open(Math.floor(bytesPerReview * 3.5));
    const games = [
      ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4'],
      ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5'],
      ['c4', 'e5', 'Nc3', 'Nf6', 'g3', 'd5', 'cxd5'],
      ['Nf3', 'd5', 'g3', 'Nf6', 'Bg2', 'e6', 'O-O'],
    ].map((sans) => fixtureReview(sans, 'fast'));
    store.putReview(games[0]!, 100);
    store.putReview(games[1]!, 200);
    store.putReview(games[2]!, 300);
    // Reading game 0 makes it recently used, so game 1 is the eviction candidate.
    store.getReview(games[0]!.gameKey, 4_000_000_000);
    store.putReview(games[3]!, 400);
    const stats = store.stats();
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
    expect(store.getReview(games[1]!.gameKey, 400)).toBeUndefined();
    expect(store.getReview(games[0]!.gameKey, 400)).toBeDefined();
    expect(store.getReview(games[3]!.gameKey, 400)).toBeDefined();
  });

  it('drops a record it cannot read instead of serving it', async () => {
    const put = fixtureReview(SCHOLAR, 'fast');
    store.putReview(put);
    // Corrupt the row through a second handle (the store is a single file).
    const { DatabaseSync } = sqlite!;
    const { gzipSync } = await import('node:zlib');
    const db = new DatabaseSync(path.join(dir, 'reviews.sqlite'));
    db.prepare('UPDATE reviews SET record = ? WHERE game_key = ?').run(
      gzipSync(JSON.stringify({ version: 1 })),
      put.gameKey,
    );
    db.close();
    expect(store.getReview(put.gameKey)).toBeUndefined();
    expect(store.stats().reviews).toBe(0);
  });

  it('clear() empties both tables', () => {
    store.putReview(fixtureReview(SCHOLAR));
    store.putPositions('d:18', [{ fen: START_FEN, result: { eval: { cp: 0 } } }]);
    store.clear();
    expect(store.stats()).toMatchObject({ reviews: 0, positions: 0, bytes: 0 });
  });
});

describe('loadSqlite', () => {
  it('reports whether node:sqlite exists on this Node', async () => {
    const mod = await loadSqlite();
    const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
    const expected = major > 22 || (major === 22 && minor >= 13);
    expect(mod !== null).toBe(expected);
  });
});
