/**
 * PKCE helpers (RFC 7636) for the lichess OAuth login: random verifier/state and the S256
 * challenge. Uses the Web Crypto API (`crypto.getRandomValues`, `crypto.subtle.digest`), which
 * is available in secure contexts (https, localhost) and in Node 20 / jsdom tests.
 */

/** RFC 4648 §5 base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `byteLength` random bytes, base64url encoded (4/3 characters per byte, unreserved charset). */
export function randomUrlSafe(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Code verifier: 64 random bytes → 86 characters (RFC 7636 requires 43–128). */
export function createVerifier(): string {
  return randomUrlSafe(64);
}

/** OAuth `state` (CSRF protection for the redirect): 24 random bytes → 32 characters. */
export function createState(): string {
  return randomUrlSafe(24);
}

/** S256 code challenge: base64url(SHA-256(ASCII(verifier))). */
export async function challengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
