import { LINK_DEFAULTS } from '@daisychess/engine-core';

export interface BackoffOptions {
  minMs?: number;
  maxMs?: number;
  /** Relative jitter, e.g. 0.2 for ±20 %. */
  jitter?: number;
}

/**
 * Delay before reconnect number `attempt` (1 = first retry): `min * 2^(attempt-1)` capped at
 * `max`, then ±`jitter` (ADR-020 §3: 1 s → 60 s, ±20 %, forever). `random` returns [0, 1).
 */
export function reconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
  opts: BackoffOptions = {},
): number {
  const min = opts.minMs ?? LINK_DEFAULTS.reconnectMinMs;
  const max = opts.maxMs ?? LINK_DEFAULTS.reconnectMaxMs;
  const jitter = opts.jitter ?? LINK_DEFAULTS.reconnectJitter;
  const n = Math.max(1, Math.floor(attempt));
  // 2^(n-1) overflows to Infinity for large n; Math.min handles that.
  const base = Math.min(min * 2 ** (n - 1), max);
  const factor = 1 + jitter * (2 * random() - 1);
  return Math.max(0, Math.round(base * factor));
}
