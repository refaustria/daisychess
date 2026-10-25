import { describe, expect, it } from 'vitest';
import {
  MAX_TOKEN_LENGTH,
  TOKEN_ALPHABET,
  TOKEN_ID_LENGTH,
  TOKEN_KINDS,
  TOKEN_LENGTH,
  TOKEN_PATTERNS,
  TOKEN_PREFIXES,
  TOKEN_SECRET_LENGTH,
  TOKEN_TIERS,
  TokenIdSchema,
  TokenTierSchema,
  formatToken,
  hasReservedPrefix,
  isLegacyToken,
  parseToken,
} from './index.js';

const ID = 'abcdefgh';
const SECRET = 'abcdefghijklmnopqrstuvwxyz234567';
const PLAYER = `dc1_${ID}_${SECRET}`;
const NODE = `dcn_${ID}_${SECRET}`;

describe('token constants', () => {
  it('describe the ADR-020 format: 8-char id, 32-char secret, lowercase base32', () => {
    expect(TOKEN_ALPHABET).toHaveLength(32);
    expect(TOKEN_ALPHABET).toBe('abcdefghijklmnopqrstuvwxyz234567');
    expect(TOKEN_ID_LENGTH).toBe(8);
    expect(TOKEN_SECRET_LENGTH).toBe(32);
    expect(TOKEN_LENGTH).toBe(45);
    expect(PLAYER).toHaveLength(TOKEN_LENGTH);
    expect(TOKEN_LENGTH).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);
    expect(TOKEN_KINDS).toEqual(['player', 'node']);
    expect(TOKEN_PREFIXES).toEqual({ player: 'dc1_', node: 'dcn_' });
    expect(TOKEN_TIERS).toEqual(['small', 'standard', 'full']);
  });

  it('patterns accept exactly the alphabet', () => {
    expect(TOKEN_PATTERNS.id.test(ID)).toBe(true);
    expect(TOKEN_PATTERNS.id.test('abcdefg')).toBe(false);
    expect(TOKEN_PATTERNS.id.test('abcdefg1')).toBe(false); // 1 is not base32
    expect(TOKEN_PATTERNS.id.test('ABCDEFGH')).toBe(false);
    expect(TOKEN_PATTERNS.secret.test(SECRET)).toBe(true);
    expect(TOKEN_PATTERNS.secret.test(`${SECRET}a`)).toBe(false);
    expect(TOKEN_PATTERNS.player.test(PLAYER)).toBe(true);
    expect(TOKEN_PATTERNS.node.test(NODE)).toBe(true);
    expect(TOKEN_PATTERNS.player.test(NODE)).toBe(false);
  });

  it('TokenIdSchema and TokenTierSchema validate', () => {
    expect(TokenIdSchema.safeParse(ID).success).toBe(true);
    expect(TokenIdSchema.safeParse('local').success).toBe(false);
    expect(TokenIdSchema.safeParse('ABCDEFGH').success).toBe(false);
    for (const tier of TOKEN_TIERS) expect(TokenTierSchema.safeParse(tier).success).toBe(true);
    expect(TokenTierSchema.safeParse('huge').success).toBe(false);
  });
});

describe('formatToken', () => {
  it('builds both kinds', () => {
    expect(formatToken('player', ID, SECRET)).toBe(PLAYER);
    expect(formatToken('node', ID, SECRET)).toBe(NODE);
  });

  it('throws on malformed parts (minting-side programming error)', () => {
    expect(() => formatToken('player', 'short', SECRET)).toThrow(TypeError);
    expect(() => formatToken('player', ID, 'short')).toThrow(TypeError);
    expect(() => formatToken('player', ID.toUpperCase(), SECRET)).toThrow(TypeError);
    expect(() => formatToken('player', ID, `${SECRET.slice(1)}1`)).toThrow(TypeError);
    // Runtime callers may pass an unchecked string for the kind.
    expect(() => formatToken('device' as 'player', ID, SECRET)).toThrow(TypeError);
  });
});

describe('parseToken', () => {
  it('round-trips formatToken', () => {
    expect(parseToken(PLAYER)).toEqual({ kind: 'player', id: ID, secret: SECRET });
    expect(parseToken(NODE)).toEqual({ kind: 'node', id: ID, secret: SECRET });
    for (const kind of TOKEN_KINDS) {
      const id = 'z7z7z7z7';
      const secret = '2'.repeat(32);
      expect(parseToken(formatToken(kind, id, secret))).toEqual({ kind, id, secret });
    }
  });

  it.each([
    ['empty', ''],
    ['not a string', 42],
    ['null', null],
    ['legacy token', 'my-shared-secret'],
    ['uppercase id', `dc1_${ID.toUpperCase()}_${SECRET}`],
    ['uppercase secret', `dc1_${ID}_${SECRET.toUpperCase()}`],
    ['unknown prefix', `dc2_${ID}_${SECRET}`],
    ['short id', `dc1_${ID.slice(1)}_${SECRET}`],
    ['long id', `dc1_${ID}a_${SECRET}`],
    ['short secret', `dc1_${ID}_${SECRET.slice(1)}`],
    ['long secret', `dc1_${ID}_${SECRET}a`],
    ['digit outside base32', `dc1_${ID}_${SECRET.slice(1)}1`],
    ['missing separator', `dc1_${ID}${SECRET}a`],
    ['leading whitespace', ` ${PLAYER}`],
    ['trailing newline', `${PLAYER}\n`],
    ['trailing whitespace of same length', `${PLAYER.slice(0, -1)} `],
    ['dash instead of underscore', `dc1-${ID}_${SECRET}`],
  ])('rejects %s', (_name, raw) => {
    expect(parseToken(raw)).toBeNull();
  });
});

describe('isLegacyToken / hasReservedPrefix', () => {
  it('a plain shared secret is legacy', () => {
    expect(isLegacyToken('my-shared-secret')).toBe(true);
    expect(isLegacyToken('x'.repeat(MAX_TOKEN_LENGTH))).toBe(true);
    expect(isLegacyToken('dc1')).toBe(true); // no separator → not a reserved prefix
  });

  it('empty, too long, non-string and prefixed tokens are not legacy', () => {
    expect(isLegacyToken('')).toBe(false);
    expect(isLegacyToken('x'.repeat(MAX_TOKEN_LENGTH + 1))).toBe(false);
    expect(isLegacyToken(undefined)).toBe(false);
    expect(isLegacyToken(7)).toBe(false);
    expect(isLegacyToken(PLAYER)).toBe(false);
    expect(isLegacyToken(NODE)).toBe(false);
    // Reserved prefix but malformed: neither parseable nor legacy → bad_token on the hub.
    expect(isLegacyToken('dc1_oops')).toBe(false);
    expect(parseToken('dc1_oops')).toBeNull();
    expect(isLegacyToken('dcn_')).toBe(false);
  });

  it('hasReservedPrefix', () => {
    expect(hasReservedPrefix('dc1_x')).toBe(true);
    expect(hasReservedPrefix('dcn_x')).toBe(true);
    expect(hasReservedPrefix('dc1x')).toBe(false);
    expect(hasReservedPrefix('DC1_x')).toBe(false);
    expect(hasReservedPrefix('')).toBe(false);
  });
});
