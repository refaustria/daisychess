import { describe, expect, it } from 'vitest';
import { reconnectDelayMs } from './backoff.js';

describe('reconnectDelayMs', () => {
  const mid = () => 0.5; // factor 1
  it('doubles from 1 s and caps at 60 s (ADR-020 §3 defaults)', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 100, 5_000].map((n) => reconnectDelayMs(n, mid))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000,
    ]);
  });
  it('applies ±20 % jitter around the base', () => {
    expect(reconnectDelayMs(1, () => 0)).toBe(800);
    expect(reconnectDelayMs(1, () => 0.999_999)).toBe(1_200);
    expect(reconnectDelayMs(10, () => 0)).toBe(48_000);
    for (let i = 0; i < 100; i++) {
      const d = reconnectDelayMs(3);
      expect(d).toBeGreaterThanOrEqual(3_200);
      expect(d).toBeLessThanOrEqual(4_800);
    }
  });
  it('treats attempts below 1 as the first and honours custom bounds', () => {
    expect(reconnectDelayMs(0, mid)).toBe(1_000);
    expect(reconnectDelayMs(-3, mid)).toBe(1_000);
    expect(reconnectDelayMs(3, mid, { minMs: 10, maxMs: 25, jitter: 0 })).toBe(25);
  });
});
