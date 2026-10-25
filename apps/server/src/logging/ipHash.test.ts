import { describe, expect, it } from 'vitest';
import { IpHasher, requestSerializer } from './ipHash.js';

const DAY = 86_400_000;

function hasher(start: number) {
  const clock = { t: start };
  let n = 0;
  const h = new IpHasher({ now: () => clock.t, randomSalt: () => `salt-${++n}` });
  return { h, clock };
}

describe('IpHasher (M24-15)', () => {
  it('is stable within a UTC day and 12 base64url characters long', () => {
    const { h, clock } = hasher(5 * DAY + 1000);
    const a = h.hash('198.51.100.7');
    expect(a).toMatch(/^[A-Za-z0-9_-]{12}$/);
    clock.t = 6 * DAY - 1;
    expect(h.hash('198.51.100.7')).toBe(a);
    expect(h.hash('198.51.100.8')).not.toBe(a);
  });

  it('rotates the salt at UTC midnight', () => {
    const { h, clock } = hasher(5 * DAY + 1000);
    const a = h.hash('198.51.100.7');
    clock.t = 6 * DAY;
    const b = h.hash('198.51.100.7');
    expect(b).not.toBe(a);
    expect(h.hash('198.51.100.7')).toBe(b);
  });

  it('uses a random salt per instance (restart changes hashes) and never contains the address', () => {
    const a = new IpHasher().hash('2001:db8::7');
    const b = new IpHasher().hash('2001:db8::7');
    expect(a).not.toBe(b);
    expect(a).not.toContain('2001');
  });

  it('requestSerializer drops the query string and the raw address', () => {
    const out = requestSerializer(['127.0.0.1'])({
      method: 'GET',
      url: '/api/portal/cb?code=lip_secret&state=x',
      ip: '127.0.0.1',
      raw: { socket: { remoteAddress: '127.0.0.1' } },
      headers: { 'x-real-ip': '198.51.100.7', cookie: 'dc_portal=abc' },
    });
    expect(out.url).toBe('/api/portal/cb');
    expect(out.ipHash).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(JSON.stringify(out)).not.toMatch(/198\.51|lip_|cookie|abc/);
  });
});
