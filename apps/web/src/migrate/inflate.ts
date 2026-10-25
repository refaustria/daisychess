/**
 * Synchronous raw DEFLATE decoder (RFC 1951) for the `#migrate=` payload (ADR-021).
 *
 * The legacy c.referee.at page compresses with `CompressionStream('deflate-raw')`; the browser's
 * `DecompressionStream` is asynchronous, but the import has to finish before any store module
 * reads localStorage at import time (main.tsx imports are evaluated synchronously). This small
 * decoder (after Mark Adler's `puff`) keeps that path synchronous and caps the output size, so a
 * crafted payload cannot inflate into a memory bomb.
 */

export class InflateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InflateError';
  }
}

const MAX_BITS = 15;

interface Huffman {
  count: Uint16Array;
  symbol: Uint16Array;
}

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * Canonical Huffman table from code lengths. Returns the number of unused codes (0 = complete,
 * > 0 = incomplete, which DEFLATE allows only for a single distance code); throws when the
 * lengths are over-subscribed.
 */
function build(lengths: ArrayLike<number>, n: number, h: Huffman): number {
  h.count.fill(0);
  for (let s = 0; s < n; s++) h.count[lengths[s] as number]! += 1;
  if (h.count[0] === n) return 0; // no codes: complete, but decoding with it fails
  let left = 1;
  for (let len = 1; len <= MAX_BITS; len++) {
    left <<= 1;
    left -= h.count[len]!;
    if (left < 0) throw new InflateError('over-subscribed code lengths');
  }
  const offs = new Uint16Array(MAX_BITS + 1);
  for (let len = 1; len < MAX_BITS; len++) offs[len + 1] = offs[len]! + h.count[len]!;
  for (let s = 0; s < n; s++) {
    const l = lengths[s] as number;
    if (l !== 0) h.symbol[offs[l]!++] = s;
  }
  return left;
}

const newHuffman = (n: number): Huffman => ({
  count: new Uint16Array(MAX_BITS + 1),
  symbol: new Uint16Array(n),
});

/** Inflates raw DEFLATE `data`; throws {@link InflateError} on corrupt input or output above `maxOutput` bytes. */
export function inflateRaw(data: Uint8Array, maxOutput: number): Uint8Array {
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(Math.min(Math.max(1024, data.length * 4), maxOutput));
  let outLen = 0;

  const bits = (need: number): number => {
    let val = bitBuf;
    while (bitCnt < need) {
      if (pos >= data.length) throw new InflateError('unexpected end of input');
      val |= data[pos++]! << bitCnt;
      bitCnt += 8;
    }
    bitBuf = val >>> need;
    bitCnt -= need;
    return val & ((1 << need) - 1);
  };

  const ensure = (extra: number): void => {
    const need = outLen + extra;
    if (need > maxOutput) throw new InflateError('output exceeds the size limit');
    if (need <= out.length) return;
    const next = new Uint8Array(Math.min(maxOutput, Math.max(need, out.length * 2)));
    next.set(out.subarray(0, outLen));
    out = next;
  };

  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAX_BITS; len++) {
      code |= bits(1);
      const count = h.count[len]!;
      if (code - count < first) return h.symbol[index + (code - first)]!;
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new InflateError('invalid Huffman code');
  };

  const codes = (lencode: Huffman, distcode: Huffman): void => {
    for (;;) {
      let sym = decode(lencode);
      if (sym < 256) {
        ensure(1);
        out[outLen++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) throw new InflateError('invalid length symbol');
        const len = LEN_BASE[sym]! + bits(LEN_EXTRA[sym]!);
        const dsym = decode(distcode);
        if (dsym >= 30) throw new InflateError('invalid distance symbol');
        const dist = DIST_BASE[dsym]! + bits(DIST_EXTRA[dsym]!);
        if (dist > outLen) throw new InflateError('distance too far back');
        ensure(len);
        for (let i = 0; i < len; i++) {
          out[outLen] = out[outLen - dist]!;
          outLen++;
        }
      }
    }
  };

  const stored = (): void => {
    bitBuf = 0;
    bitCnt = 0; // discard the rest of the current byte
    if (pos + 4 > data.length) throw new InflateError('unexpected end of input');
    const len = data[pos]! | (data[pos + 1]! << 8);
    const nlen = data[pos + 2]! | (data[pos + 3]! << 8);
    pos += 4;
    if (len !== (~nlen & 0xffff)) throw new InflateError('stored block length mismatch');
    if (pos + len > data.length) throw new InflateError('unexpected end of input');
    ensure(len);
    out.set(data.subarray(pos, pos + len), outLen);
    outLen += len;
    pos += len;
  };

  let fixedLen: Huffman | null = null;
  let fixedDist: Huffman | null = null;
  const fixed = (): void => {
    if (!fixedLen || !fixedDist) {
      const lengths = new Uint8Array(288);
      lengths.fill(8, 0, 144);
      lengths.fill(9, 144, 256);
      lengths.fill(7, 256, 280);
      lengths.fill(8, 280, 288);
      fixedLen = newHuffman(288);
      build(lengths, 288, fixedLen);
      fixedDist = newHuffman(30);
      build(new Uint8Array(30).fill(5), 30, fixedDist);
    }
    codes(fixedLen, fixedDist);
  };

  const dynamic = (): void => {
    const nlen = bits(5) + 257;
    const ndist = bits(5) + 1;
    const ncode = bits(4) + 4;
    if (nlen > 286 || ndist > 30) throw new InflateError('bad dynamic block counts');
    const lengths = new Uint8Array(320);
    for (let i = 0; i < ncode; i++) lengths[CL_ORDER[i]!] = bits(3);
    const lencode = newHuffman(286);
    if (build(lengths, 19, lencode) !== 0) throw new InflateError('incomplete code length code');
    let index = 0;
    const all = new Uint8Array(nlen + ndist);
    while (index < nlen + ndist) {
      const sym = decode(lencode);
      if (sym < 16) {
        all[index++] = sym;
        continue;
      }
      let len = 0;
      let rep: number;
      if (sym === 16) {
        if (index === 0) throw new InflateError('repeat with no previous length');
        len = all[index - 1]!;
        rep = 3 + bits(2);
      } else if (sym === 17) {
        rep = 3 + bits(3);
      } else {
        rep = 11 + bits(7);
      }
      if (index + rep > nlen + ndist) throw new InflateError('too many code lengths');
      while (rep--) all[index++] = len;
    }
    if (all[256] === 0) throw new InflateError('no end-of-block code');
    const litcode = newHuffman(286);
    const lit = build(all.subarray(0, nlen), nlen, litcode);
    if (lit < 0 || (lit > 0 && nlen - litcode.count[0]! !== 1)) {
      throw new InflateError('incomplete literal/length code');
    }
    const distcode = newHuffman(30);
    const dst = build(all.subarray(nlen), ndist, distcode);
    if (dst < 0 || (dst > 0 && ndist - distcode.count[0]! !== 1)) {
      throw new InflateError('incomplete distance code');
    }
    codes(litcode, distcode);
  };

  let last: number;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) stored();
    else if (type === 1) fixed();
    else if (type === 2) dynamic();
    else throw new InflateError('invalid block type');
  } while (!last);
  return out.slice(0, outLen);
}
