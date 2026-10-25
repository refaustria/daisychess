import { describe, expect, it } from 'vitest';
import { qrMatrix, qrPath } from './qr';

describe('qr', () => {
  it('builds a square matrix with finder patterns', () => {
    const m = qrMatrix('https://c.referee.at/#setup-token=dc1_ABCD2345_SECRET');
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.every((r) => r.length === m.length)).toBe(true);
    // top-left finder pattern: 7 dark modules across the first row
    expect(m[0]!.slice(0, 7).every(Boolean)).toBe(true);
  });

  it('renders runs as path data', () => {
    expect(qrPath([[true, true, false, true]], 1)).toBe('M1 1h2v1h-2zM4 1h1v1h-1z');
    expect(qrPath([[false]], 0)).toBe('');
  });
});
