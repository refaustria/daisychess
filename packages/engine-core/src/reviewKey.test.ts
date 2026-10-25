import { describe, expect, it } from 'vitest';
import {
  REVIEW_KEY_SALT,
  REVIEW_PRESETS,
  coversPreset,
  reviewGameKey,
  strongerPreset,
} from './reviewKey.js';
import { sha256Hex } from './sha256.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('reviewGameKey', () => {
  it('is the SHA-256 of salt, start FEN and the UCI moves', () => {
    expect(reviewGameKey(START, ['e2e4', 'e7e5'])).toBe(
      sha256Hex(`${REVIEW_KEY_SALT}\n${START}\ne2e4 e7e5`),
    );
    expect(REVIEW_KEY_SALT).toBe('daisychess-review-v1');
  });

  it('ignores surrounding whitespace of the FEN but not the move order', () => {
    expect(reviewGameKey(` ${START} `, ['e2e4'])).toBe(reviewGameKey(START, ['e2e4']));
    expect(reviewGameKey(START, ['e2e4', 'e7e5'])).not.toBe(reviewGameKey(START, ['e7e5', 'e2e4']));
    expect(reviewGameKey(START, [])).not.toBe(reviewGameKey(START, ['e2e4']));
  });
});

describe('presets', () => {
  it('orders deep above fast', () => {
    expect(REVIEW_PRESETS).toEqual(['fast', 'deep']);
    expect(coversPreset('deep', 'fast')).toBe(true);
    expect(coversPreset('fast', 'fast')).toBe(true);
    expect(coversPreset('fast', 'deep')).toBe(false);
    expect(coversPreset(undefined, 'fast')).toBe(false);
    expect(strongerPreset(undefined, 'fast')).toBe('fast');
    expect(strongerPreset('deep', 'fast')).toBe('deep');
    expect(strongerPreset('fast', 'deep')).toBe('deep');
  });
});
