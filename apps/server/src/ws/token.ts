import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time secret comparison (access token, ADR-010; player tokens, ADR-013): both sides
 * are hashed first, so neither the content nor the length of the expected value leaks through
 * timing.
 */
export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
