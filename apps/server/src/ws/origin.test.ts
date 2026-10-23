import { describe, expect, it } from 'vitest';
import { isOriginAllowed, normalizeOrigin, parseAllowedOrigins } from './origin.js';

describe('parseAllowedOrigins', () => {
  it('returns null (same-host policy) when unset or empty', () => {
    expect(parseAllowedOrigins(undefined)).toBeNull();
    expect(parseAllowedOrigins('')).toBeNull();
    expect(parseAllowedOrigins('  ')).toBeNull();
  });
  it('returns * for the wildcard', () => {
    expect(parseAllowedOrigins('*')).toBe('*');
  });
  it('normalises a comma-separated list', () => {
    expect(parseAllowedOrigins(' https://C.referee.at , http://localhost:8080/ ')).toEqual([
      'https://c.referee.at',
      'http://localhost:8080',
    ]);
    expect(parseAllowedOrigins('https://c.referee.at:443')).toEqual(['https://c.referee.at']);
  });
  it('rejects entries that are not http(s) origins instead of silently allowing nothing', () => {
    expect(() => parseAllowedOrigins('c.referee.at')).toThrow(/not an http\(s\) origin/);
    expect(() => parseAllowedOrigins('wss://c.referee.at')).toThrow();
    expect(() => parseAllowedOrigins('https://a.example,,')).toThrow();
  });
});

describe('normalizeOrigin', () => {
  it('lower-cases and strips paths and default ports', () => {
    expect(normalizeOrigin('HTTPS://C.Referee.AT/ws?x=1')).toBe('https://c.referee.at');
    expect(normalizeOrigin('http://localhost:5180')).toBe('http://localhost:5180');
    expect(normalizeOrigin('http://[::1]:5180')).toBe('http://[::1]:5180');
  });
  it('returns null for non-http schemes, credentials and garbage', () => {
    expect(normalizeOrigin('null')).toBeNull();
    expect(normalizeOrigin('file:///etc/passwd')).toBeNull();
    expect(normalizeOrigin('chrome-extension://abc')).toBeNull();
    expect(normalizeOrigin('https://user:pw@c.referee.at')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
  });
});

describe('isOriginAllowed', () => {
  it('allows requests without an Origin header (non-browser clients)', () => {
    expect(isOriginAllowed(undefined, 'c.referee.at', null)).toBe(true);
    expect(isOriginAllowed(undefined, 'c.referee.at', ['https://other.example'])).toBe(true);
  });
  it('default policy: origin host must equal the request host, ports ignored', () => {
    expect(isOriginAllowed('https://c.referee.at', 'c.referee.at', null)).toBe(true);
    expect(isOriginAllowed('https://C.REFEREE.AT', 'c.referee.at', null)).toBe(true);
    expect(isOriginAllowed('http://localhost:8080', 'localhost', null)).toBe(true); // docker compose
    expect(isOriginAllowed('http://example.com:8080', 'example.com:8080', null)).toBe(true);
    expect(isOriginAllowed('https://evil.example', 'c.referee.at', null)).toBe(false);
    expect(isOriginAllowed('https://c.referee.at.evil.example', 'c.referee.at', null)).toBe(false);
    expect(isOriginAllowed('null', 'c.referee.at', null)).toBe(false); // sandboxed iframe / file://
    expect(isOriginAllowed('https://c.referee.at', undefined, null)).toBe(false);
    expect(isOriginAllowed('garbage', 'c.referee.at', null)).toBe(false);
  });
  it('default policy: loopback origins may talk to loopback hosts on any port (dev server)', () => {
    expect(isOriginAllowed('http://localhost:5180', '127.0.0.1:8580', null)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5180', 'localhost:8580', null)).toBe(true);
    expect(isOriginAllowed('http://[::1]:5180', '127.0.0.1:8580', null)).toBe(true);
    expect(isOriginAllowed('http://localhost:5180', 'c.referee.at', null)).toBe(false);
    expect(isOriginAllowed('https://c.referee.at', '127.0.0.1:8580', null)).toBe(false);
  });
  it('explicit list: exact normalised match only', () => {
    const list = ['https://c.referee.at', 'http://localhost:8080'];
    expect(isOriginAllowed('https://c.referee.at', 'anything', list)).toBe(true);
    expect(isOriginAllowed('https://c.referee.at:443', 'anything', list)).toBe(true);
    expect(isOriginAllowed('http://localhost:8080', 'anything', list)).toBe(true);
    expect(isOriginAllowed('http://localhost:8081', 'anything', list)).toBe(false);
    expect(isOriginAllowed('http://c.referee.at', 'c.referee.at', list)).toBe(false); // scheme matters
    expect(isOriginAllowed('https://evil.example', 'c.referee.at', list)).toBe(false);
  });
  it('wildcard allows everything', () => {
    expect(isOriginAllowed('https://evil.example', 'c.referee.at', '*')).toBe(true);
    expect(isOriginAllowed('null', 'c.referee.at', '*')).toBe(true);
  });
});
