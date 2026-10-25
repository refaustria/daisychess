import { describe, expect, it } from 'vitest';
import {
  PORTAL_COOKIE,
  WindowLimiter,
  hashSessionId,
  newSessionId,
  portalOriginAllowed,
  sessionCookie,
  sessionIdFromCookies,
} from './auth.js';

describe('portal auth helpers', () => {
  it('session ids are 256 random bits in base64url, stored as sha256 hex', () => {
    const id = newSessionId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionId()).not.toBe(id);
    expect(newSessionId(() => new Uint8Array(32))).toBe('A'.repeat(43));
    expect(hashSessionId(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionId(id)).not.toContain(id);
  });

  it('reads the session cookie only when well-formed', () => {
    const id = newSessionId();
    expect(sessionIdFromCookies(`a=1; ${PORTAL_COOKIE}=${id}; b=2`)).toBe(id);
    expect(sessionIdFromCookies(`${PORTAL_COOKIE}=short`)).toBeNull();
    expect(sessionIdFromCookies(`dc_portal=${id}`)).toBeNull();
    expect(sessionIdFromCookies(undefined)).toBeNull();
    expect(sessionIdFromCookies('garbage')).toBeNull();
  });

  it('cookie flags: __Host- prefix, Secure, HttpOnly, SameSite=Strict, Path=/, no Domain', () => {
    const c = sessionCookie('abc', 30 * 86_400_000);
    expect(c).toBe(
      '__Host-dc_portal=abc; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Strict',
    );
    expect(c).not.toMatch(/domain/i);
    expect(sessionCookie('abc', 0)).toBe(
      '__Host-dc_portal=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict',
    );
  });

  it('origin rule: required; PUBLIC_ORIGIN / explicit list; else same host; never *', () => {
    const pub = 'https://c.referee.at';
    expect(portalOriginAllowed(undefined, 'c.referee.at', pub, null)).toBe(false);
    expect(portalOriginAllowed('null', 'c.referee.at', pub, null)).toBe(false);
    expect(portalOriginAllowed('https://c.referee.at', 'c.referee.at', pub, null)).toBe(true);
    expect(portalOriginAllowed('https://C.referee.at', 'x', pub, null)).toBe(true);
    expect(portalOriginAllowed('https://evil.example', 'c.referee.at', pub, null)).toBe(false);
    expect(portalOriginAllowed('http://c.referee.at', 'c.referee.at', pub, null)).toBe(false);
    expect(portalOriginAllowed('https://other.example', 'h', null, ['https://other.example'])).toBe(
      true,
    );
    // Same host without configuration; `*` does not open the portal.
    expect(portalOriginAllowed('http://localhost:5173', 'localhost:8580', null, null)).toBe(true);
    expect(portalOriginAllowed('https://evil.example', 'c.referee.at', null, '*')).toBe(false);
    expect(portalOriginAllowed('https://c.referee.at', 'c.referee.at', null, '*')).toBe(true);
  });

  it('WindowLimiter counts per key and window, with a bounded key set', () => {
    const l = new WindowLimiter({ max: 2, windowMs: 1_000 }, 2);
    expect(l.allow('a', 0)).toBe(true);
    expect(l.allow('a', 10)).toBe(true);
    expect(l.allow('a', 20)).toBe(false);
    expect(l.retryAfterMs('a', 20)).toBe(980);
    expect(l.allow('b', 20)).toBe(true);
    expect(l.allow('a', 1_000)).toBe(true);
    l.allow('c', 1_001);
    expect(l.size).toBeLessThanOrEqual(2);
    expect(l.retryAfterMs('zzz', 0)).toBe(0);
  });
});
