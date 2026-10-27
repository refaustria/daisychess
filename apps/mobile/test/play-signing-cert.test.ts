import { describe, expect, it } from 'vitest';
import { PlayError } from '../scripts/play-publish.mjs';
import {
  explainSigningCertError,
  fetchSigningCerts,
  formatFingerprint,
} from '../scripts/play-signing-cert.mjs';

const hex = Array.from({ length: 32 }, (_, i) => (i * 7 + 1).toString(16).padStart(2, '0')).join(
  '',
);
const colon = hex.toUpperCase().replace(/../g, '$&:').slice(0, -1);
const b64 = Buffer.from(hex, 'hex').toString('base64');

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('formatFingerprint', () => {
  it('accepts hex, colon hex and base64 and emits keytool-style uppercase', () => {
    expect(formatFingerprint(hex)).toBe(colon);
    expect(formatFingerprint(colon)).toBe(colon);
    expect(formatFingerprint(b64)).toBe(colon);
    expect(formatFingerprint(Buffer.from(hex, 'hex').toString('base64url'))).toBe(colon);
  });
  it('rejects garbage and wrong lengths', () => {
    expect(() => formatFingerprint('abc')).toThrow(/unrecognised/);
    expect(() => formatFingerprint(Buffer.alloc(31).toString('base64').padEnd(43, 'A'))).toThrow();
  });
});

describe('fetchSigningCerts', () => {
  it('requests the versionCode and returns distinct fingerprints', async () => {
    const { impl, calls } = fakeFetch(200, {
      generatedApks: [{ certificateSha256Hash: hex }, { certificateSha256Hash: b64 }],
    });
    const r = await fetchSigningCerts({
      fetchImpl: impl,
      accessToken: 'tok',
      packageName: 'org.daisychess.app',
      versionCode: 9,
    });
    expect(r).toEqual([colon]);
    expect(calls[0]?.url).toBe(
      'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/org.daisychess.app/generatedApks/9',
    );
    expect(calls[0]?.init.headers).toEqual({ authorization: 'Bearer tok' });
  });
  it('throws when there are no certificates', async () => {
    const { impl } = fakeFetch(200, {});
    await expect(
      fetchSigningCerts({ fetchImpl: impl, accessToken: 't', packageName: 'p', versionCode: 9 }),
    ).rejects.toThrow(/no generated APKs/);
  });
  it.each([403, 404])('raises a PlayError with a hint on %i', async (status) => {
    const { impl } = fakeFetch(status, 'nope');
    const err = await fetchSigningCerts({
      fetchImpl: impl,
      accessToken: 't',
      packageName: 'p',
      versionCode: 9,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlayError);
    const msg = explainSigningCertError(err);
    expect(msg).toContain(`HTTP ${status}`);
    expect(msg).toContain('Hint');
  });
});
