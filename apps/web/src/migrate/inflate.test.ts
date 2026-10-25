import { constants, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { InflateError, inflateRaw } from './inflate';

const enc = (s: string) => new TextEncoder().encode(s);

function pseudoRandom(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

describe('inflateRaw', () => {
  const samples: Array<[string, Uint8Array]> = [
    ['empty', new Uint8Array(0)],
    ['short text', enc('{"daisychess.theme":"dark"}')],
    [
      'repetitive JSON',
      enc(
        JSON.stringify({
          items: Array.from({ length: 400 }, (_, i) => ({
            id: `e4-e5-${i % 7}`,
            due: 1_700_000_000_000 + i,
          })),
        }),
      ),
    ],
    ['random bytes', pseudoRandom(70_000)],
    ['unicode', enc('Grünfeld, Nimzo-Indian, 王手, ♞♛ '.repeat(50))],
  ];

  for (const [name, input] of samples) {
    for (const level of [0, 1, 6, 9]) {
      it(`round-trips ${name} at level ${level}`, () => {
        const packed = deflateRawSync(input, { level });
        expect(Buffer.from(inflateRaw(packed, 1 << 20))).toEqual(Buffer.from(input));
      });
    }
    it(`round-trips ${name} with fixed Huffman codes`, () => {
      const packed = deflateRawSync(input, { strategy: constants.Z_FIXED });
      expect(Buffer.from(inflateRaw(packed, 1 << 20))).toEqual(Buffer.from(input));
    });
  }

  it('handles long back-references (distance up to 32 KiB)', () => {
    const block = pseudoRandom(20_000, 3);
    const input = new Uint8Array(60_000);
    input.set(block, 0);
    input.set(block, 30_000);
    const packed = deflateRawSync(input, { level: 9 });
    expect(Buffer.from(inflateRaw(packed, 1 << 20))).toEqual(Buffer.from(input));
  });

  it('refuses output above the cap (decompression bomb)', () => {
    const packed = deflateRawSync(new Uint8Array(1 << 20)); // 1 MiB of zeros, ~1 kB packed
    expect(packed.length).toBeLessThan(2_000);
    expect(() => inflateRaw(packed, 64 * 1024)).toThrow(InflateError);
    expect(inflateRaw(packed, 1 << 20).length).toBe(1 << 20);
  });

  it('throws on truncated input', () => {
    const packed = deflateRawSync(enc('hello hello hello hello world'.repeat(20)));
    expect(() => inflateRaw(packed.subarray(0, packed.length - 3), 1 << 20)).toThrow(InflateError);
  });

  it('throws on garbage', () => {
    expect(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 1024)).toThrow(InflateError);
    expect(() => inflateRaw(new Uint8Array(0), 1024)).toThrow(InflateError);
    // stored block with a wrong NLEN
    expect(() => inflateRaw(new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 1, 2, 3]), 1024)).toThrow(
      /length mismatch/,
    );
  });

  it('rejects a back-reference before the start of the output', () => {
    // fixed block: BFINAL=1, BTYPE=01, then length code 257 (len 3) + distance code 0 (dist 1)
    // with nothing written yet. Bits LSB first: 1, 10 (type 1 -> bits "1","0"), 0000001 (257), 00000 (dist 0)
    const packed = new Uint8Array([0b00000011, 0b00000010, 0b00000000]);
    expect(() => inflateRaw(packed, 1024)).toThrow(InflateError);
  });

  it('decodes a multi-block stream', () => {
    const a = deflateRawSync(enc('first block '.repeat(10)), {
      finishFlush: constants.Z_SYNC_FLUSH,
    });
    // a sync-flushed stream ends with an empty stored block (not final); append a final one.
    const b = new Uint8Array([0x01, 0x00, 0x00, 0xff, 0xff]);
    const both = new Uint8Array(a.length + b.length);
    both.set(a, 0);
    both.set(b, a.length);
    expect(new TextDecoder().decode(inflateRaw(both, 4096))).toBe('first block '.repeat(10));
  });
});
