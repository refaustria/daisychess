/**
 * Game key and preset order of stored reviews (ADR-016, ADR-017). Shared by the browser cache
 * and the server review store so that both compute the same key for the same game.
 */
import { sha256Hex } from './sha256.js';

/** Salt of {@link reviewGameKey}; bump together with the record format. */
export const REVIEW_KEY_SALT = 'daisychess-review-v1';

/**
 * Deterministic key of a game: SHA-256 (hex) of the start FEN and the UCI moves. Headers, the
 * viewed ply and the SAN spelling do not matter. The server recomputes it from the moves it is
 * sent and refuses records offered under another key.
 */
export function reviewGameKey(startFen: string, uciMoves: readonly string[]): string {
  return sha256Hex(`${REVIEW_KEY_SALT}\n${startFen.trim()}\n${uciMoves.join(' ')}`);
}

export const REVIEW_PRESETS = ['fast', 'deep'] as const;
export type ReviewPreset = (typeof REVIEW_PRESETS)[number];

const PRESET_RANK: Record<ReviewPreset, number> = { fast: 1, deep: 2 };

/** True when a review with preset `stored` makes a run with `requested` unnecessary (deep ≥ fast). */
export function coversPreset(stored: ReviewPreset | undefined, requested: ReviewPreset): boolean {
  return stored !== undefined && PRESET_RANK[stored] >= PRESET_RANK[requested];
}

/** The stronger of two presets. */
export function strongerPreset(a: ReviewPreset | undefined, b: ReviewPreset): ReviewPreset {
  return a !== undefined && PRESET_RANK[a] >= PRESET_RANK[b] ? a : b;
}
