import { describe, expect, it } from 'vitest';
import { lastDates } from './DailyCard';

describe('lastDates', () => {
  it('lists 30 UTC dates ending today', () => {
    const d = lastDates('2026-03-02');
    expect(d).toHaveLength(30);
    expect(d[29]).toBe('2026-03-02');
    expect(d[0]).toBe('2026-02-01');
  });
});
