import { describe, expect, it } from 'vitest';
import { UnlimitedLedger } from './UnlimitedLedger.js';

describe('UnlimitedLedger', () => {
  it('never refuses and counts held slots without going negative', () => {
    const l = new UnlimitedLedger();
    expect(l.maxPerIp).toBe(Number.POSITIVE_INFINITY);
    for (let i = 0; i < 1_000; i++) expect(l.tryReserve()).toBe(true);
    expect(l.total).toBe(1_000);
    for (let i = 0; i < 1_001; i++) l.release();
    expect(l.total).toBe(0);
  });
});
