import { useGameStore } from '../store/gameStore';

/**
 * Opens the review of the finished game. The automatic (fast) review of this game, if it is
 * running or done, is kept and just shown; otherwise a deep review starts. Used by the Play panel
 * and the phone action bar.
 */
export async function reviewThisGame(setTab: (t: 'review') => void): Promise<void> {
  const { REVIEW_PRESETS, useReviewStore } = await import('../review/reviewStore');
  setTab('review');
  const review = useReviewStore.getState();
  if (
    (review.status === 'running' || review.status === 'done') &&
    review.reviewed !== undefined &&
    review.reviewed === useGameStore.getState().moves
  ) {
    return;
  }
  review.reset();
  void review.start({ ...REVIEW_PRESETS.deep });
}
