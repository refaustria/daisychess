import { randomBytes } from 'node:crypto';
import { TOKEN_ALPHABET } from '@daisychess/engine-core';

/**
 * Lowercase RFC 4648 base32 (no padding) of `bytes`, the alphabet of the token formats
 * (`TOKEN_ALPHABET`, ADR-020 M24-2 clarification 6). 5 bytes → 8 characters, 20 bytes → 32.
 */
export function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += TOKEN_ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += TOKEN_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** Source of randomness; injectable so tests can force id collisions. */
export type RandomSource = (size: number) => Uint8Array;

export const cryptoRandom: RandomSource = (size) => randomBytes(size);

/**
 * `length` random base32 characters (5 bits each). `length` must be a multiple of 8 so every
 * character carries full entropy (8 → 40 bits, 32 → 160 bits).
 */
export function randomBase32(length: number, random: RandomSource = cryptoRandom): string {
  if (!Number.isInteger(length) || length <= 0 || length % 8 !== 0) {
    throw new TypeError('length must be a positive multiple of 8');
  }
  return base32(random((length / 8) * 5));
}
