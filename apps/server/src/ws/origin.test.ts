import { describe, expect, it } from 'vitest';
import {
  isOriginAllowed,
  normalizeAppOrigin,
  normalizeOrigin,
  parseAllowedOrigins,
} from './origin.js';

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
    expect(parseAllowedOrigins(' https://Play.DaisyChess.org , http://localhost:8080/ ')).toEqual([
      'https://play.daisychess.org',
      'http://localhost:8080',
    ]);
    expect(parseAllowedOrigins('https://play.daisychess.org:443')).toEqual([
      'https://play.daisychess.org',
    ]);
  });
  it('rejects entries that are not http(s) origins instead of silently allowing nothing', () => {
    expect(() => parseAllowedOrigins('play.daisychess.org')).toThrow(/not an http\(s\) origin/);
    expect(() => parseAllowedOrigins('wss://play.daisychess.org')).toThrow();
    expect(() => parseAllowedOrigins('https://a.example,,')).toThrow();
  });
});

describe('normalizeOrigin', () => {
  it('lower-cases and strips paths and default ports', () => {
    expect(normalizeOrigin('HTTPS://Play.DaisyChess.ORG/ws?x=1')).toBe(
      'https://play.daisychess.org',
    );
    expect(normalizeOrigin('http://localhost:5180')).toBe('http://localhost:5180');
    expect(normalizeOrigin('http://[::1]:5180')).toBe('http://[::1]:5180');
  });
  it('returns null for non-http schemes, credentials and garbage', () => {
    expect(normalizeOrigin('null')).toBeNull();
    expect(normalizeOrigin('file:///etc/passwd')).toBeNull();
    expect(normalizeOrigin('chrome-extension://abc')).toBeNull();
    expect(normalizeOrigin('https://user:pw@play.daisychess.org')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
  });
});

describe('isOriginAllowed', () => {
  it('allows requests without an Origin header (non-browser clients)', () => {
    expect(isOriginAllowed(undefined, 'play.daisychess.org', null)).toBe(true);
    expect(isOriginAllowed(undefined, 'play.daisychess.org', ['https://other.example'])).toBe(true);
  });
  it('default policy: origin host must equal the request host, ports ignored', () => {
    expect(isOriginAllowed('https://play.daisychess.org', 'play.daisychess.org', null)).toBe(true);
    expect(isOriginAllowed('https://PLAY.DAISYCHESS.ORG', 'play.daisychess.org', null)).toBe(true);
    expect(isOriginAllowed('http://localhost:8080', 'localhost', null)).toBe(true); // docker compose
    expect(isOriginAllowed('http://example.com:8080', 'example.com:8080', null)).toBe(true);
    expect(isOriginAllowed('https://evil.example', 'play.daisychess.org', null)).toBe(false);
    expect(
      isOriginAllowed('https://play.daisychess.org.evil.example', 'play.daisychess.org', null),
    ).toBe(false);
    expect(isOriginAllowed('null', 'play.daisychess.org', null)).toBe(false); // sandboxed iframe / file://
    expect(isOriginAllowed('https://play.daisychess.org', undefined, null)).toBe(false);
    expect(isOriginAllowed('garbage', 'play.daisychess.org', null)).toBe(false);
  });
  it('default policy: loopback origins may talk to loopback hosts on any port (dev server)', () => {
    expect(isOriginAllowed('http://localhost:5180', '127.0.0.1:8580', null)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5180', 'localhost:8580', null)).toBe(true);
    expect(isOriginAllowed('http://[::1]:5180', '127.0.0.1:8580', null)).toBe(true);
    expect(isOriginAllowed('http://localhost:5180', 'play.daisychess.org', null)).toBe(false);
    expect(isOriginAllowed('https://play.daisychess.org', '127.0.0.1:8580', null)).toBe(false);
  });
  it('explicit list: exact normalised match only', () => {
    const list = ['https://play.daisychess.org', 'http://localhost:8080'];
    expect(isOriginAllowed('https://play.daisychess.org', 'anything', list)).toBe(true);
    expect(isOriginAllowed('https://play.daisychess.org:443', 'anything', list)).toBe(true);
    expect(isOriginAllowed('http://localhost:8080', 'anything', list)).toBe(true);
    expect(isOriginAllowed('http://localhost:8081', 'anything', list)).toBe(false);
    expect(isOriginAllowed('http://play.daisychess.org', 'play.daisychess.org', list)).toBe(false); // scheme matters
    expect(isOriginAllowed('https://evil.example', 'play.daisychess.org', list)).toBe(false);
  });
  it('wildcard allows everything', () => {
    expect(isOriginAllowed('https://evil.example', 'play.daisychess.org', '*')).toBe(true);
    expect(isOriginAllowed('null', 'play.daisychess.org', '*')).toBe(true);
  });
});

// ADR-022: native app WebView origins (iOS `capacitor://app.daisychess.org`).
const APP_ORIGINS =
  'https://play.daisychess.org,https://app.daisychess.org,capacitor://app.daisychess.org';

describe('app origins (capacitor:)', () => {
  it('normalizeAppOrigin accepts exactly capacitor://host[:port], lower-cased', () => {
    expect(normalizeAppOrigin('capacitor://app.daisychess.org')).toBe(
      'capacitor://app.daisychess.org',
    );
    expect(normalizeAppOrigin('CAPACITOR://App.DaisyChess.ORG')).toBe(
      'capacitor://app.daisychess.org',
    );
    expect(normalizeAppOrigin('capacitor://app.daisychess.org/')).toBe(
      'capacitor://app.daisychess.org',
    );
    expect(normalizeAppOrigin('capacitor://localhost:8443')).toBe('capacitor://localhost:8443');
  });
  it('normalizeAppOrigin rejects credentials, paths, query, fragment, empty hosts, other schemes', () => {
    for (const bad of [
      'capacitor://user@app.daisychess.org',
      'capacitor://user:pw@app.daisychess.org',
      'capacitor://app.daisychess.org/index.html',
      'capacitor://app.daisychess.org/ws',
      'capacitor://app.daisychess.org?x=1',
      'capacitor://app.daisychess.org?',
      'capacitor://app.daisychess.org#',
      'capacitor://',
      'capacitor:app.daisychess.org',
      'ionic://app.daisychess.org',
      'daisychess://app.daisychess.org',
      'https://app.daisychess.org',
      'null',
      '',
    ]) {
      expect(normalizeAppOrigin(bad), bad).toBeNull();
    }
  });
  it('normalizeOrigin (http(s) only) never returns an app origin', () => {
    expect(normalizeOrigin('capacitor://app.daisychess.org')).toBeNull();
  });
  it('parseAllowedOrigins accepts explicit capacitor entries next to http(s) ones', () => {
    expect(parseAllowedOrigins(APP_ORIGINS)).toEqual([
      'https://play.daisychess.org',
      'https://app.daisychess.org',
      'capacitor://app.daisychess.org',
    ]);
    expect(parseAllowedOrigins(' Capacitor://APP.daisychess.org/ ')).toEqual([
      'capacitor://app.daisychess.org',
    ]);
  });
  it('parseAllowedOrigins rejects capacitor entries with credentials or paths', () => {
    expect(() => parseAllowedOrigins('capacitor://u:p@app.daisychess.org')).toThrow(
      /capacitor:\/\/host/,
    );
    expect(() =>
      parseAllowedOrigins('https://play.daisychess.org,capacitor://app.daisychess.org/x'),
    ).toThrow();
    expect(() => parseAllowedOrigins('capacitor://')).toThrow();
    expect(() => parseAllowedOrigins('ionic://app.daisychess.org')).toThrow();
  });
  it('default policy never accepts an app origin, whatever the Host', () => {
    expect(isOriginAllowed('capacitor://app.daisychess.org', 'app.daisychess.org', null)).toBe(
      false,
    );
    expect(isOriginAllowed('capacitor://localhost', 'localhost', null)).toBe(false);
    expect(isOriginAllowed('capacitor://localhost', '127.0.0.1:8580', null)).toBe(false);
    // The Android origin is plain https: same-host rules apply (it never matches our hosts).
    expect(isOriginAllowed('https://app.daisychess.org', 'play.daisychess.org', null)).toBe(false);
  });
  it('explicit list: listed app origins are accepted, others and malformed ones are not', () => {
    const list = parseAllowedOrigins(APP_ORIGINS);
    expect(isOriginAllowed('capacitor://app.daisychess.org', 'play.daisychess.org', list)).toBe(
      true,
    );
    expect(isOriginAllowed('capacitor://APP.daisychess.org', 'play.daisychess.org', list)).toBe(
      true,
    );
    expect(isOriginAllowed('https://app.daisychess.org', 'play.daisychess.org', list)).toBe(true);
    expect(isOriginAllowed('capacitor://localhost', 'play.daisychess.org', list)).toBe(false);
    expect(isOriginAllowed('capacitor://evil.example', 'play.daisychess.org', list)).toBe(false);
    expect(isOriginAllowed('ionic://app.daisychess.org', 'play.daisychess.org', list)).toBe(false);
    expect(isOriginAllowed('http://app.daisychess.org', 'play.daisychess.org', list)).toBe(false);
    expect(
      isOriginAllowed('capacitor://user@app.daisychess.org', 'play.daisychess.org', list),
    ).toBe(false);
    expect(
      isOriginAllowed('capacitor://app.daisychess.org/path', 'play.daisychess.org', list),
    ).toBe(false);
    expect(
      isOriginAllowed('capacitor://app.daisychess.org.evil.example', 'play.daisychess.org', list),
    ).toBe(false);
  });
  it('a list without app origins rejects them', () => {
    const list = parseAllowedOrigins('https://play.daisychess.org');
    expect(isOriginAllowed('capacitor://app.daisychess.org', 'play.daisychess.org', list)).toBe(
      false,
    );
    expect(isOriginAllowed('https://app.daisychess.org', 'play.daisychess.org', list)).toBe(false);
  });
});
