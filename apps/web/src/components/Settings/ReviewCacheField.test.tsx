// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearReviewCache,
  configureReviewCache,
  countStoredReviews,
  putStoredReview,
  REVIEW_CACHE_VERSION,
} from '../../review/reviewCache';
import { FakeReviewServer } from '../../review/fakeReviewServer';
import { useReviewStore } from '../../review/reviewStore';
import { scholarSummary } from '../../review/testFixtures';
import { configureApiConnection } from '../../server/apiConnection';
import { ReviewCacheField, formatBytes, serverStatsLabel } from './ReviewCacheField';
import { SettingsPanel } from './SettingsPanel';

const put = (gameKey: string) =>
  putStoredReview({
    gameKey,
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves: ['e4', 'e5'],
    preset: 'deep',
    options: { depth: 18 },
    summary: scholarSummary(),
    moveDetails: {},
    engine: { kind: 'server' },
    createdAt: Date.now(),
    version: REVIEW_CACHE_VERSION,
  });

beforeEach(async () => {
  configureReviewCache(null);
  await clearReviewCache();
});
afterEach(() => {
  cleanup();
  configureReviewCache(undefined);
  configureApiConnection(null);
});

describe('ReviewCacheField', () => {
  it('shows the number of stored reviews, follows changes and clears the cache', async () => {
    await put('a');
    await put('b');
    useReviewStore.setState({
      stored: {
        preset: 'deep',
        createdAt: 1,
        engine: { kind: 'server' },
        fromCache: true,
        source: 'local',
      },
    });
    render(<ReviewCacheField />);
    const count = screen.getByTestId('review-cache-count');
    await waitFor(() => expect(count.textContent).toBe('2 stored reviews'));
    await put('c');
    await waitFor(() => expect(count.textContent).toBe('3 stored reviews'));

    fireEvent.click(screen.getByRole('button', { name: 'Clear cache' }));
    await waitFor(() => expect(count.textContent).toBe('0 stored reviews'));
    expect(await countStoredReviews()).toBe(0);
    expect(useReviewStore.getState().stored).toBeUndefined();
    expect(
      (screen.getByRole('button', { name: 'Clear cache' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows the server store size when the engine server reports one (ADR-017)', async () => {
    const server = new FakeReviewServer();
    server.bytes = 1_234_000_000;
    server.maxBytes = 5_000_000_000;
    configureApiConnection({ createSocket: server.createSocket });
    render(<ReviewCacheField />);
    await waitFor(() =>
      expect(screen.getByTestId('review-cache-server').textContent).toBe(
        'Server: 0 reviews · 1.2 GB of 5 GB',
      ),
    );
    expect(serverStatsLabel({ enabled: true, reviews: 1, positions: 0, bytes: 2_500_000, maxBytes: 2.5e9 })).toBe(
      'Server: 1 review · 2.5 MB of 2.5 GB',
    );
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(12_345)).toBe('12 kB');
  });

  it('shows no server line without a server store', async () => {
    render(<ReviewCacheField />);
    await waitFor(() => expect(screen.getByTestId('review-cache-count').textContent).toBe('0 stored reviews'));
    expect(screen.queryByTestId('review-cache-server')).toBeNull();
  });

  it('is part of the Settings panel', async () => {
    await put('a');
    render(<SettingsPanel />);
    expect(screen.getByRole('group', { name: 'Review cache' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('review-cache-count').textContent).toBe('1 stored review'),
    );
  });
});
