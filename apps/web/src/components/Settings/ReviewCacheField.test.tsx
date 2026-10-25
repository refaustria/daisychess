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
import { useReviewStore } from '../../review/reviewStore';
import { scholarSummary } from '../../review/testFixtures';
import { ReviewCacheField } from './ReviewCacheField';
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
});

describe('ReviewCacheField', () => {
  it('shows the number of stored reviews, follows changes and clears the cache', async () => {
    await put('a');
    await put('b');
    useReviewStore.setState({
      stored: { preset: 'deep', createdAt: 1, engine: { kind: 'server' }, fromCache: true },
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

  it('is part of the Settings panel', async () => {
    await put('a');
    render(<SettingsPanel />);
    expect(screen.getByRole('group', { name: 'Review cache' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('review-cache-count').textContent).toBe('1 stored review'),
    );
  });
});
