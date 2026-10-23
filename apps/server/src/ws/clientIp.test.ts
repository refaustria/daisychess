import { describe, expect, it } from 'vitest';
import {
  IpSessionLedger,
  isLoopback,
  normalizeIp,
  parseTrustedProxies,
  resolveClientIp,
} from './clientIp.js';

describe('normalizeIp', () => {
  it('unwraps IPv4-mapped IPv6, lower-cases, strips brackets and zones', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIp(' 2001:DB8::1 ')).toBe('2001:db8::1');
    expect(normalizeIp('[::1]')).toBe('::1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('203.0.113.9')).toBe('203.0.113.9');
  });

  it('rejects anything that is not an IP address', () => {
    for (const bad of [undefined, '', 'localhost', '1.2.3.4, 5.6.7.8', '1.2.3.4:80', '999.1.1.1']) {
      expect(normalizeIp(bad)).toBeNull();
    }
  });
});

describe('isLoopback', () => {
  it('matches 127.0.0.0/8 and ::1 only', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.1.2.3')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(isLoopback('::2')).toBe(false);
  });
});

describe('resolveClientIp', () => {
  it('trusts X-Real-IP from a loopback peer (nginx on the same host)', () => {
    expect(resolveClientIp('127.0.0.1', '203.0.113.5')).toBe('203.0.113.5');
    expect(resolveClientIp('::ffff:127.0.0.1', '::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(resolveClientIp('::1', ['2001:db8::7', '1.1.1.1'])).toBe('2001:db8::7');
  });

  it('ignores a spoofed X-Real-IP from a non-proxy peer', () => {
    expect(resolveClientIp('198.51.100.20', '127.0.0.1')).toBe('198.51.100.20');
    expect(resolveClientIp('::ffff:198.51.100.20', '203.0.113.5')).toBe('198.51.100.20');
  });

  it('falls back to the peer when the header is missing or malformed', () => {
    expect(resolveClientIp('127.0.0.1', undefined)).toBe('127.0.0.1');
    expect(resolveClientIp('127.0.0.1', 'evil, 1.2.3.4')).toBe('127.0.0.1');
    expect(resolveClientIp(undefined, '203.0.113.5')).toBe('unknown');
  });

  it('trusts configured proxies, or every peer with *', () => {
    expect(resolveClientIp('172.18.0.3', '203.0.113.5', ['172.18.0.3'])).toBe('203.0.113.5');
    expect(resolveClientIp('172.18.0.4', '203.0.113.5', ['172.18.0.3'])).toBe('172.18.0.4');
    expect(resolveClientIp('172.18.0.4', '203.0.113.5', '*')).toBe('203.0.113.5');
  });
});

describe('parseTrustedProxies', () => {
  it('parses lists and the wildcard; rejects garbage', () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies(' ')).toEqual([]);
    expect(parseTrustedProxies('*')).toBe('*');
    expect(parseTrustedProxies('10.0.0.2, ::ffff:10.0.0.3')).toEqual(['10.0.0.2', '10.0.0.3']);
    expect(() => parseTrustedProxies('10.0.0.0/8')).toThrow(/TRUSTED_PROXIES/);
  });
});

describe('IpSessionLedger', () => {
  it('caps reservations per address and frees them on release', () => {
    const l = new IpSessionLedger(2);
    expect(l.tryReserve('a')).toBe(true);
    expect(l.tryReserve('a')).toBe(true);
    expect(l.tryReserve('a')).toBe(false);
    expect(l.tryReserve('b')).toBe(true);
    expect([l.count('a'), l.count('b'), l.total, l.addresses]).toEqual([2, 1, 3, 2]);
    l.release('a');
    expect(l.tryReserve('a')).toBe(true);
    l.release('a');
    l.release('a');
    l.release('b');
    expect([l.total, l.addresses]).toEqual([0, 0]);
    l.release('never'); // unknown address: no-op
    expect(l.total).toBe(0);
  });
});
