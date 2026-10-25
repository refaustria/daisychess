import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cachedReviewLabel,
  clearReviewCache,
  configureReviewCache,
  countStoredReviews,
  covers,
  gameKey,
  getStoredPositions,
  getStoredReview,
  MAX_STORED_POSITIONS,
  MAX_STORED_REVIEWS,
  onReviewCacheChange,
  peekStoredPreset,
  positionId,
  putStoredPositions,
  putStoredReview,
  REVIEW_CACHE_VERSION,
  reviewCacheKind,
  strongerPreset,
  warmReviewCache,
  type StoredPosition,
  type StoredReview,
} from './reviewCache';
import { sha256Hex } from './sha256';
import { scholarSummary } from './testFixtures';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function review(key: string, over: Partial<StoredReview> = {}): StoredReview {
  return {
    gameKey: key,
    startFen: START,
    moves: ['e4', 'e5'],
    preset: 'fast',
    options: { movetime: 300 },
    summary: scholarSummary(),
    moveDetails: {},
    engine: { kind: 'browser' },
    createdAt: 1_000,
    version: REVIEW_CACHE_VERSION,
    ...over,
  };
}

function position(fen: string, usedAt: number, optionsKey = 'mt:300'): StoredPosition {
  return {
    id: positionId(optionsKey, fen),
    fen,
    optionsKey,
    result: { eval: { cp: usedAt % 100 }, depth: 12 },
    usedAt,
    version: REVIEW_CACHE_VERSION,
  };
}

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
  configureReviewCache(factory);
});

afterEach(() => configureReviewCache(undefined));

describe('gameKey / sha256', () => {
  it('sha256 matches the standard test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    // Multi-byte UTF-8 and more than one block.
    expect(sha256Hex('é'.repeat(100))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic and depends only on the start position and the moves', () => {
    const k = gameKey(START, ['e2e4', 'e7e5']);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(gameKey(START, ['e2e4', 'e7e5'])).toBe(k);
    expect(gameKey(`${START} `, ['e2e4', 'e7e5'])).toBe(k);
    expect(gameKey(START, ['e2e4', 'e7e6'])).not.toBe(k);
    expect(gameKey(START, ['e2e4'])).not.toBe(k);
    expect(gameKey('8/8/8/8/8/8/8/K6k w - - 0 1', ['e2e4', 'e7e5'])).not.toBe(k);
  });
});

describe('presets and label', () => {
  it('deep covers fast, not the other way round', () => {
    expect(covers('deep', 'fast')).toBe(true);
    expect(covers('deep', 'deep')).toBe(true);
    expect(covers('fast', 'fast')).toBe(true);
    expect(covers('fast', 'deep')).toBe(false);
    expect(covers(undefined, 'fast')).toBe(false);
    expect(strongerPreset('fast', 'deep')).toBe('deep');
    expect(strongerPreset('deep', 'fast')).toBe('deep');
    expect(strongerPreset(undefined, 'fast')).toBe('fast');
  });

  it('formats the cache label (year only for other years)', () => {
    const now = new Date(2026, 9, 25, 12).getTime();
    const r = { preset: 'deep' as const, engine: { kind: 'server' as const } };
    expect(cachedReviewLabel({ ...r, createdAt: new Date(2026, 9, 25, 9).getTime() }, now)).toBe(
      'Loaded from cache (reviewed 25 Oct, deep, server)',
    );
    expect(
      cachedReviewLabel(
        { preset: 'fast', engine: { kind: 'browser' }, createdAt: new Date(2025, 0, 3).getTime() },
        now,
      ),
    ).toBe('Loaded from cache (reviewed 3 Jan 2025, fast, browser)');
  });
});

describe('review cache (IndexedDB)', () => {
  it('uses IndexedDB, stores and reads reviews, keeps the index and notifies', async () => {
    expect(await reviewCacheKind()).toBe('indexeddb');
    const changed = vi.fn();
    const off = onReviewCacheChange(changed);
    expect(await getStoredReview('a')).toBeUndefined();
    await putStoredReview(review('a'));
    expect(changed).toHaveBeenCalledTimes(1);
    const r = await getStoredReview('a');
    expect(r?.summary).toEqual(scholarSummary());
    expect(r?.moves).toEqual(['e4', 'e5']);
    expect(peekStoredPreset('a')).toBe('fast');
    expect(await countStoredReviews()).toBe(1);
    off();
  });

  it('a stronger review replaces a weaker one, never the other way round', async () => {
    await putStoredReview(review('a', { preset: 'deep', createdAt: 5 }));
    await putStoredReview(review('a', { preset: 'fast', createdAt: 6 }));
    expect((await getStoredReview('a'))?.preset).toBe('deep');
    await putStoredReview(review('b', { preset: 'fast' }));
    await putStoredReview(review('b', { preset: 'deep' }));
    expect((await getStoredReview('b'))?.preset).toBe('deep');
    expect(peekStoredPreset('b')).toBe('deep');
  });

  it('survives a reopen (new page): the index is rebuilt from the database', async () => {
    await putStoredReview(review('a', { preset: 'deep' }));
    await putStoredReview(review('b'));
    configureReviewCache(factory);
    expect(peekStoredPreset('a')).toBeUndefined(); // not loaded yet
    await warmReviewCache();
    expect(peekStoredPreset('a')).toBe('deep');
    expect(peekStoredPreset('b')).toBe('fast');
    expect(peekStoredPreset('c')).toBeUndefined();
  });

  it('keeps at most MAX_STORED_REVIEWS (oldest dropped)', async () => {
    expect(MAX_STORED_REVIEWS).toBe(500);
    configureReviewCache(factory, { maxReviews: 20 });
    for (let i = 0; i < 20 + 3; i++) {
      await putStoredReview(
        review(`k${i}`, { createdAt: 10_000 + i, summary: undefined as never }),
      );
    }
    expect(await countStoredReviews()).toBe(20);
    expect(await getStoredReview('k0')).toBeUndefined();
    expect(await getStoredReview('k2')).toBeUndefined();
    expect(await getStoredReview('k3')).toBeDefined();
  });

  it('positions: stored per FEN and budget, fetched by FEN', async () => {
    await putStoredPositions([
      position('f1', 1),
      position('f1', 2, 'd:18'),
      position('f2', 3),
      position('f3', 4),
    ]);
    const got = await getStoredPositions(['f1', 'f3', 'nope']);
    expect(got.map((p) => p.id).sort()).toEqual(['d:18|f1', 'mt:300|f1', 'mt:300|f3']);
  });

  it('positions: least recently used entries are dropped beyond MAX_STORED_POSITIONS', async () => {
    expect(MAX_STORED_POSITIONS).toBe(20_000);
    const max = 200;
    configureReviewCache(factory, { maxPositions: max });
    const batch: StoredPosition[] = [];
    for (let i = 0; i < max; i++) batch.push(position(`p${i}`, 100 + i));
    await putStoredPositions(batch);
    expect(await getStoredPositions(['p0'])).toHaveLength(1);
    // Touch p0 (newest now), then overflow by one.
    await putStoredPositions([position('p0', 1_000_000), position('extra', 1_000_001)]);
    expect(await getStoredPositions(['p0', 'extra'])).toHaveLength(2);
    expect(await getStoredPositions(['p1'])).toHaveLength(0); // oldest after the touch
    const left = await getStoredPositions(Array.from({ length: max }, (_, i) => `p${i}`));
    expect(left.length).toBe(Math.floor(max * 0.9) - 1); // 90 % kept, incl. p0 and extra
  });

  it('clear removes reviews, positions and the index', async () => {
    await putStoredReview(review('a'));
    await putStoredPositions([position('f1', 1)]);
    const changed = vi.fn();
    onReviewCacheChange(changed);
    await clearReviewCache();
    expect(changed).toHaveBeenCalled();
    expect(await countStoredReviews()).toBe(0);
    expect(await getStoredPositions(['f1'])).toEqual([]);
    expect(peekStoredPreset('a')).toBeUndefined();
  });

  it('a new schema version drops the data of the old one', async () => {
    configureReviewCache(factory, { version: REVIEW_CACHE_VERSION });
    await putStoredReview(review('a'));
    await putStoredPositions([position('f1', 1)]);
    configureReviewCache(factory, { version: REVIEW_CACHE_VERSION + 1 });
    expect(await reviewCacheKind()).toBe('indexeddb');
    expect(await getStoredReview('a')).toBeUndefined();
    expect(await getStoredPositions(['f1'])).toEqual([]);
    expect(await countStoredReviews()).toBe(0);
    await putStoredReview(review('b'));
    expect((await getStoredReview('b'))?.version).toBe(REVIEW_CACHE_VERSION + 1);
  });
});

describe('review cache fallback (no IndexedDB)', () => {
  it('memory only when configured without IndexedDB', async () => {
    configureReviewCache(null);
    expect(await reviewCacheKind()).toBe('memory');
    await putStoredReview(review('a'));
    expect((await getStoredReview('a'))?.preset).toBe('fast');
    expect(peekStoredPreset('a')).toBe('fast');
    await putStoredPositions([position('f1', 1), position('f2', 2)]);
    expect(await getStoredPositions(['f2'])).toHaveLength(1);
    expect(await countStoredReviews()).toBe(1);
    await clearReviewCache();
    expect(await countStoredReviews()).toBe(0);
  });

  it('falls back to memory when IndexedDB cannot be opened (private mode)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = {
      open: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as IDBFactory;
    configureReviewCache(broken);
    expect(await reviewCacheKind()).toBe('memory');
    await putStoredReview(review('a'));
    expect(await getStoredReview('a')).toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('memory: reviews and positions bounded as well', async () => {
    configureReviewCache(null, { maxPositions: 50, maxReviews: 3 });
    const batch: StoredPosition[] = [];
    for (let i = 0; i <= 50; i++) batch.push(position(`p${i}`, i));
    await putStoredPositions(batch);
    expect(await getStoredPositions(['p0'])).toHaveLength(0);
    expect(await getStoredPositions(['p50'])).toHaveLength(1);
    for (let i = 0; i < 5; i++) await putStoredReview(review(`r${i}`, { createdAt: i }));
    expect(await countStoredReviews()).toBe(3);
    expect(await getStoredReview('r1')).toBeUndefined();
    expect(await getStoredReview('r2')).toBeDefined();
  });
});
