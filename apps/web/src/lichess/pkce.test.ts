import { describe, expect, it } from 'vitest';
import { base64url, challengeS256, createState, createVerifier, randomUrlSafe } from './pkce';

const URL_SAFE = /^[A-Za-z0-9_-]+$/;

describe('pkce', () => {
  it('computes the RFC 7636 appendix B challenge', async () => {
    expect(await challengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('base64url encodes without padding and with the URL-safe alphabet', () => {
    expect(base64url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_');
    expect(base64url(new Uint8Array([0x66]))).toBe('Zg');
    expect(base64url(new Uint8Array([]))).toBe('');
  });

  it('creates verifiers of 43–128 unreserved characters, different each time', () => {
    const a = createVerifier();
    const b = createVerifier();
    expect(a.length).toBeGreaterThanOrEqual(64);
    expect(a.length).toBeLessThanOrEqual(128);
    expect(a).toMatch(URL_SAFE);
    expect(a).not.toBe(b);
  });

  it('creates random URL-safe states', () => {
    const s = createState();
    expect(s).toMatch(URL_SAFE);
    expect(s.length).toBe(32);
    expect(s).not.toBe(createState());
    expect(randomUrlSafe(3)).toHaveLength(4);
  });
});
