/**
 * `window.__chesslab.runReview` (Playwright / console): loads a PGN into the game store and
 * reviews it with the review store's engine. Imported lazily by `engine/devHook.ts`.
 */
import type { ReviewSummary } from '@chesslab/engine-core';
import { useGameStore } from '../store/gameStore';
import { useReviewStore, type ReviewStatus } from './reviewStore';

export interface RunReviewOptions {
  pgn: string;
  movetime?: number;
  depth?: number;
}

export interface RunReviewResult {
  status: ReviewStatus;
  summary?: ReviewSummary;
  error?: string;
  /** Wall time of the review including engine load (ms). */
  ms: number;
}

declare module '../engine/devHook' {
  interface ChessLabDevHook {
    runReview(options: RunReviewOptions): Promise<RunReviewResult>;
  }
}

export async function runReview(options: RunReviewOptions): Promise<RunReviewResult> {
  if (!useGameStore.getState().loadPgn(options.pgn)) throw new Error('Invalid PGN');
  const review = useReviewStore.getState();
  review.reset();
  const t0 = performance.now();
  const summary = await review.start(
    options.movetime !== undefined ? { movetime: options.movetime } : { depth: options.depth },
  );
  const { status, error } = useReviewStore.getState();
  return { status, summary, error, ms: Math.round(performance.now() - t0) };
}
