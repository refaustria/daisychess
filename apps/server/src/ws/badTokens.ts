import type { RateLimit } from '../sessions/rateLimit.js';

/** ADR-020 §4.1: 20 bad tokens within 10 minutes from one address → `rate_limited` and close. */
export const DEFAULT_BAD_TOKEN_LIMIT: RateLimit = Object.freeze({ max: 20, windowMs: 10 * 60_000 });

export interface BadTokenLimiterOptions {
  limit?: RateLimit;
  /** Addresses tracked at once; beyond it the stalest are forgotten. Default 50 000. */
  maxAddresses?: number;
  now?: () => number;
}

/**
 * Per-address counter of failed `hello.token` checks (`bad_token`) on `/ws` (ADR-020 §4.1), on
 * top of nginx's handshake limit: it stops token guessing. Once an address has `limit.max`
 * failures within `limit.windowMs`, every further `hello` *with* a token from it is refused with
 * `rate_limited` until the oldest failure leaves the window (a `hello` without a token — rooms,
 * review reads — still works). Memory is bounded: at most `limit.max` timestamps per address and
 * `maxAddresses` addresses (least recently failing first out). In memory only; nothing persisted.
 */
export class BadTokenLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly limit: RateLimit;
  private readonly maxAddresses: number;
  private readonly now: () => number;

  constructor(opts: BadTokenLimiterOptions = {}) {
    this.limit = opts.limit ?? DEFAULT_BAD_TOKEN_LIMIT;
    this.maxAddresses = opts.maxAddresses ?? 50_000;
    this.now = opts.now ?? Date.now;
    if (!Number.isInteger(this.limit.max) || this.limit.max < 1) {
      throw new RangeError('limit.max must be an integer >= 1');
    }
  }

  /** True while `ip` is over the limit. */
  blocked(ip: string): boolean {
    const times = this.prune(ip);
    return times !== undefined && times.length >= this.limit.max;
  }

  /** Records a failure of `ip`; returns true when the address is now blocked. */
  fail(ip: string): boolean {
    const now = this.now();
    const times = this.prune(ip) ?? [];
    times.push(now);
    if (times.length > this.limit.max) times.splice(0, times.length - this.limit.max);
    // Re-insert so the Map's order is "least recently failing first".
    this.failures.delete(ip);
    this.failures.set(ip, times);
    this.evict(now);
    return times.length >= this.limit.max;
  }

  /** Addresses with at least one failure in the window. */
  get addresses(): number {
    return this.failures.size;
  }

  private prune(ip: string): number[] | undefined {
    const times = this.failures.get(ip);
    if (!times) return undefined;
    const now = this.now();
    while (times.length > 0 && now - times[0]! >= this.limit.windowMs) times.shift();
    if (times.length === 0) {
      this.failures.delete(ip);
      return undefined;
    }
    return times;
  }

  private evict(now: number): void {
    if (this.failures.size <= this.maxAddresses) return;
    for (const [ip, times] of this.failures) {
      if (this.failures.size <= this.maxAddresses) break;
      const last = times[times.length - 1] ?? 0;
      // Stale entries go first; when everything is fresh, the least recently failing goes.
      if (now - last >= this.limit.windowMs || this.failures.size > this.maxAddresses) {
        this.failures.delete(ip);
      }
    }
  }
}
