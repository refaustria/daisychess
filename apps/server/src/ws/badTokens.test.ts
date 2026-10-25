import { describe, expect, it } from 'vitest';
import { BadTokenLimiter, DEFAULT_BAD_TOKEN_LIMIT } from './badTokens.js';

describe('BadTokenLimiter (ADR-020 §4.1)', () => {
  it('defaults to 20 failures in 10 minutes', () => {
    expect(DEFAULT_BAD_TOKEN_LIMIT).toEqual({ max: 20, windowMs: 600_000 });
  });

  it('blocks an address at the 20th failure within the window and unblocks as failures age out', () => {
    let t = 0;
    const l = new BadTokenLimiter({ now: () => t });
    for (let i = 1; i < 20; i++) {
      expect(l.fail('1.2.3.4')).toBe(false);
      t += 1_000;
    }
    expect(l.blocked('1.2.3.4')).toBe(false);
    expect(l.fail('1.2.3.4')).toBe(true);
    expect(l.blocked('1.2.3.4')).toBe(true);
    // Other addresses are unaffected.
    expect(l.blocked('5.6.7.8')).toBe(false);
    // The first failure (t=0) leaves the window at t=600 000.
    t = 599_999;
    expect(l.blocked('1.2.3.4')).toBe(true);
    t = 600_000;
    expect(l.blocked('1.2.3.4')).toBe(false);
    // Long after: forgotten entirely.
    t = 10_000_000;
    expect(l.blocked('1.2.3.4')).toBe(false);
    expect(l.addresses).toBe(0);
  });

  it('keeps at most max timestamps per address and a bounded number of addresses', () => {
    let t = 0;
    const l = new BadTokenLimiter({
      limit: { max: 3, windowMs: 1_000 },
      maxAddresses: 2,
      now: () => t,
    });
    for (let i = 0; i < 100; i++) l.fail('a');
    expect(l.blocked('a')).toBe(true);
    t = 1;
    l.fail('b');
    t = 2;
    l.fail('c');
    expect(l.addresses).toBe(2);
    // `a` failed least recently and was evicted.
    expect(l.blocked('a')).toBe(false);
  });

  it('rejects a limit below 1', () => {
    expect(() => new BadTokenLimiter({ limit: { max: 0, windowMs: 1 } })).toThrow(RangeError);
  });
});
