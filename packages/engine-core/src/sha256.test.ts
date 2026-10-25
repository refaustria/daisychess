import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256.js';

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes UTF-8 bytes and long inputs', () => {
    expect(sha256Hex('é'.repeat(100))).toMatch(/^[0-9a-f]{64}$/);
    // Known digests of multi-byte input (2-, 3- and 4-byte UTF-8 sequences).
    expect(sha256Hex('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
    expect(sha256Hex('€')).toBe('c4cc90ed3d26f12d4b08a75140970a7904035c31cbb4515a83f19b9003c00d1d');
    expect(sha256Hex('😀')).toBe('f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9');
    expect(sha256Hex('aé€😀b')).toBe(
      '8a00f8175dce6d699426e095c72fc70576a9d7acad5c28fdf463118b17e06c6e',
    );
    // 1 million 'a' (FIPS vector)
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });
});
