import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REVIEW_BOUNDS } from '@daisychess/engine-core';
import { fixtureReview, ITALIAN, SCHOLAR, START_FEN } from '../../test/review-fixtures.js';
import type { PoolLogger } from '../engines/EnginePool.js';
import { ReviewService, replaySan } from './ReviewService.js';
import { ReviewStore, loadSqlite } from './ReviewStore.js';

const sqlite = await loadSqlite();
const silent: PoolLogger = { info() {}, warn() {}, error() {}, debug() {} };
const holder = { id: 1, ip: '10.0.0.1', analysisAllowed: true };
const guest = { id: 2, ip: '10.0.0.2', analysisAllowed: false };

describe('replaySan', () => {
  it('turns SAN into UCI and rejects illegal games', () => {
    expect(replaySan(START_FEN, SCHOLAR)).toEqual([
      'e2e4',
      'e7e5',
      'f1c4',
      'b8c6',
      'd1h5',
      'g8f6',
      'h5f7',
    ]);
    expect(replaySan(START_FEN, ['e4', 'e4'])).toBeNull();
    expect(replaySan(START_FEN, ['Nf6', 'e5'])).toBeNull(); // Nf6 is Black's knight
    expect(replaySan('not a fen', ['e4'])).toBeNull();
    expect(replaySan('8/8/8/8/8/8/8/8 w - - 0 1', ['e4'])).toBeNull();
  });
});

describe('ReviewService without a store', () => {
  const service = new ReviewService({ store: null, putPerIpPerDay: 5, logger: silent });

  it('is disabled: reads find nothing, writes are refused with `disabled`', () => {
    expect(service.enabled).toBe(false);
    expect(service.stats()).toEqual({
      enabled: false,
      reviews: 0,
      positions: 0,
      bytes: 0,
      maxBytes: 0,
    });
    const put = fixtureReview(SCHOLAR);
    expect(service.handle(holder, { type: 'review.get', gameKey: put.gameKey, startFen: START_FEN, moves: put.moves })).toEqual({
      type: 'review.record',
      gameKey: put.gameKey,
      found: false,
    });
    expect(service.handle(holder, put)).toEqual({
      type: 'review.stored',
      gameKey: put.gameKey,
      stored: false,
      reason: 'disabled',
    });
    expect(
      service.handle(holder, { type: 'review.positions.get', optsKey: 'mt:300', fens: [START_FEN] }),
    ).toEqual({ type: 'review.positions', optsKey: 'mt:300', results: {} });
    expect(
      service.handle(holder, {
        type: 'review.positions.put',
        optsKey: 'mt:300',
        entries: [{ fen: START_FEN, result: { eval: { cp: 0 } } }],
      }),
    ).toEqual({ type: 'review.positions.stored', optsKey: 'mt:300', stored: false, reason: 'disabled' });
    expect(service.handle(holder, { type: 'review.stats.get' })).toMatchObject({
      type: 'review.stats',
      enabled: false,
    });
  });
});

describe.skipIf(!sqlite)('ReviewService with a store', () => {
  let dir: string;
  let store: ReviewStore;
  let service: ReviewService;
  let now = 1_700_000_000_000;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-review-service-'));
    store = await ReviewStore.open({ path: path.join(dir, 'r.sqlite'), maxBytes: 10_000_000 }, silent);
    service = new ReviewService({ store, putPerIpPerDay: 3, logger: silent, now: () => now });
  });
  afterEach(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores for a token holder and serves everyone (also with a different SAN spelling rejected)', () => {
    const put = fixtureReview(SCHOLAR, 'deep');
    expect(service.handle(holder, put)).toEqual({ type: 'review.stored', gameKey: put.gameKey, stored: true });
    const get = { type: 'review.get' as const, gameKey: put.gameKey, startFen: START_FEN, moves: put.moves };
    expect(service.handle(guest, get)).toEqual({
      type: 'review.record',
      gameKey: put.gameKey,
      found: true,
      preset: 'deep',
      record: put.record,
      createdAt: now,
    });
    // Same key, different moves claimed: not served.
    expect(service.handle(guest, { ...get, moves: ITALIAN })).toMatchObject({ found: false });
    expect(service.handle(guest, { ...get, startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 2' })).toMatchObject({ found: false });
    expect(service.stats()).toMatchObject({ enabled: true, reviews: 1 });
  });

  it('refuses writes without the token, under a foreign key, for illegal games and oversized records', () => {
    const put = fixtureReview(SCHOLAR);
    expect(service.handle(guest, put)).toMatchObject({ stored: false, reason: 'unauthorized' });
    const foreign = fixtureReview(ITALIAN);
    expect(service.handle(holder, { ...put, gameKey: foreign.gameKey })).toMatchObject({
      stored: false,
      reason: 'key_mismatch',
    });
    // Another legal game under this key: refused. (A different SAN spelling of the same move,
    // e.g. `Qxf7` without the `#`, gives the same UCI and therefore the same key — accepted.)
    expect(service.handle(holder, { ...put, moves: [...put.moves.slice(0, -1), 'Qxe5+'] })).toMatchObject({
      reason: 'key_mismatch',
    });
    expect(service.handle(holder, { ...put, moves: ['e4', 'e4'] })).toMatchObject({ reason: 'illegal_game' });
    // Note: the quota counts every attempt above (3 per day): reset by moving to the next day.
    now += 86_400_000;
    const big = fixtureReview(SCHOLAR, 'fast', 'x'.repeat(199));
    // Inflate beyond the record cap with a huge moveDetails map of valid entries.
    const details = { ...big.record.moveDetails };
    const template = {
      ...details['1']!,
      bestLine: new Array<string>(16).fill('e2e4'),
      bestLineMoves: new Array<string>(16).fill('Qxf7#'),
      swing: 'allows mate in 12 after a long line'.padEnd(40, '.'),
      moveLabel: '1000...',
    };
    for (let ply = 8; Object.keys(details).length < 1000; ply++) details[String(ply)] = { ...template, ply };
    const moves = [...big.record.summary.moves];
    const move = moves[0]!;
    for (let ply = 8; moves.length < 1000; ply++) moves.push({ ...move, ply });
    const oversized = {
      ...big,
      record: { ...big.record, moveDetails: details, summary: { ...big.record.summary, moves } },
    };
    expect(JSON.stringify(oversized.record).length).toBeGreaterThan(REVIEW_BOUNDS.recordMaxBytes);
    expect(service.handle(holder, oversized)).toMatchObject({ reason: 'too_large' });
    expect(service.stats().reviews).toBe(0);
  });

  it('a weaker preset never overwrites a stronger one (superseded)', () => {
    const deep = fixtureReview(SCHOLAR, 'deep');
    const fast = fixtureReview(SCHOLAR, 'fast');
    expect(service.handle(holder, deep)).toMatchObject({ stored: true });
    expect(service.handle(holder, fast)).toEqual({
      type: 'review.stored',
      gameKey: fast.gameKey,
      stored: false,
      reason: 'superseded',
    });
    expect(service.handle(guest, { type: 'review.get', gameKey: deep.gameKey, startFen: START_FEN, moves: deep.moves })).toMatchObject({ preset: 'deep' });
  });

  it('positions: open reads, token-only writes', () => {
    const entries = [{ fen: START_FEN, result: { eval: { cp: 25 }, bestMove: 'e2e4', depth: 24 } }];
    expect(service.handle(guest, { type: 'review.positions.put', optsKey: 'mt:300', entries })).toMatchObject({
      stored: false,
      reason: 'unauthorized',
    });
    expect(service.handle(holder, { type: 'review.positions.put', optsKey: 'mt:300', entries })).toEqual({
      type: 'review.positions.stored',
      optsKey: 'mt:300',
      stored: true,
    });
    expect(service.handle(guest, { type: 'review.positions.get', optsKey: 'mt:300', fens: [START_FEN] })).toEqual({
      type: 'review.positions',
      optsKey: 'mt:300',
      results: { [START_FEN]: entries[0]!.result },
    });
    expect(service.handle(guest, { type: 'review.positions.get', optsKey: 'd:18', fens: [START_FEN] })).toEqual({
      type: 'review.positions',
      optsKey: 'd:18',
      results: {},
    });
  });

  it('caps writes per address and day (reviews and positions together), per UTC day', () => {
    const entries = [{ fen: START_FEN, result: { eval: { cp: 0 } } }];
    const put = (ip: string) =>
      service.handle({ ...holder, ip }, { type: 'review.positions.put', optsKey: 'd:18', entries });
    expect(put('a')).toMatchObject({ stored: true });
    expect(put('a')).toMatchObject({ stored: true });
    expect(service.handle({ ...holder, ip: 'a' }, fixtureReview(SCHOLAR))).toMatchObject({ stored: true });
    expect(put('a')).toMatchObject({ stored: false, reason: 'quota' });
    expect(put('b')).toMatchObject({ stored: true }); // another address
    now += 86_400_000;
    expect(put('a')).toMatchObject({ stored: true }); // next day
  });
});
