import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EloEstimate } from '@daisychess/engine-core';
import { scholarSummary } from './testFixtures';

const storeServerReview = vi.fn(async () => true);
vi.mock('./serverReviewStore', async (orig) => ({
  ...(await orig<typeof import('./serverReviewStore')>()),
  storeServerReview: (...args: unknown[]) => storeServerReview(...(args as [])),
}));

const { writeEloRecord } = await import('./eloRecord');
const { configureReviewCache, getStoredReview, putStoredReview, REVIEW_CACHE_VERSION } =
  await import('./reviewCache');
const { useReviewStore } = await import('./reviewStore');

const KEY = 'a'.repeat(64);
const est = (rating: number): EloEstimate => ({
  method: 'maia',
  rating,
  low: rating - 100,
  high: rating + 100,
  positions: 25,
  exact: true,
  maiaVersion: 1,
});

async function seed(elo?: { white?: EloEstimate; black?: EloEstimate }) {
  await putStoredReview({
    gameKey: KEY,
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves: ['e4', 'e5'],
    preset: 'deep',
    options: { depth: 18 },
    summary: scholarSummary(),
    moveDetails: {},
    engine: { kind: 'server' },
    createdAt: 42,
    version: REVIEW_CACHE_VERSION,
    ...(elo ? { elo } : {}),
  });
}

beforeEach(() => {
  configureReviewCache(null);
  storeServerReview.mockClear();
  useReviewStore.setState({ stored: undefined });
});
afterEach(() => configureReviewCache(undefined));

describe('writeEloRecord', () => {
  it('writes the estimate into the local record and re-sends it with review.put', async () => {
    await seed();
    useReviewStore.setState({
      stored: {
        preset: 'deep',
        createdAt: 42,
        engine: { kind: 'server' },
        fromCache: true,
        source: 'local',
      },
    });
    const r = await writeEloRecord(KEY, { white: est(1540), black: est(1300) });
    expect(r).toEqual({ local: true, server: true });
    const stored = await getStoredReview(KEY);
    expect(stored?.elo).toEqual({ white: est(1540), black: est(1300) });
    expect(stored?.preset).toBe('deep');
    expect(storeServerReview).toHaveBeenCalledTimes(1);
    expect(storeServerReview).toHaveBeenCalledWith(expect.objectContaining({ elo: stored!.elo }));
    // The shown review now carries it (a later request skips the run).
    expect(useReviewStore.getState().stored?.elo).toEqual(stored!.elo);
  });

  it('keeps an existing side when only the other one is written', async () => {
    await seed({ black: est(1300) });
    await writeEloRecord(KEY, { white: est(1600) });
    expect((await getStoredReview(KEY))?.elo).toEqual({ white: est(1600), black: est(1300) });
  });

  it('no local record (custom budget, cache cleared): nothing stored, nothing sent', async () => {
    const r = await writeEloRecord(KEY, { white: est(1540) });
    expect(r).toEqual({ local: false, server: false });
    expect(storeServerReview).not.toHaveBeenCalled();
  });

  it('an empty estimate is not written; a failing server is ignored', async () => {
    await seed();
    expect(await writeEloRecord(KEY, {})).toEqual({ local: false, server: false });
    storeServerReview.mockRejectedValueOnce(new Error('down'));
    expect(await writeEloRecord(KEY, { white: est(1500) })).toEqual({
      local: true,
      server: false,
    });
  });
});
