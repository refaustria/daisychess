/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- plain Node scripts (Playwright and chess.js come from apps/web, untyped here)
// Minimal PNG helpers (8-bit, non-interlaced RGB/RGBA) so asset rendering needs no image library:
// read the header for the store-spec checks, decode Chromium screenshots, drop or add the alpha
// channel and re-encode with adaptive filtering and zlib level 9 (smaller than Chromium's output).
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @param {Buffer} buf @returns {{ width: number, height: number, bitDepth: number, colorType: number, interlace: number }} */
export function readPngInfo(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  };
}

/** True when the PNG has an alpha channel (colour type 4 or 6, or a tRNS chunk). */
export function pngHasAlphaChannel(buf) {
  const { colorType } = readPngInfo(buf);
  if (colorType === 4 || colorType === 6) return true;
  for (let o = 8; o + 8 <= buf.length;) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'tRNS') return true;
    o += 12 + len;
  }
  return false;
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** @param {Buffer} buf @returns {{ width: number, height: number, channels: number, data: Buffer }} */
export function decodePng(buf) {
  const info = readPngInfo(buf);
  const channels = CHANNELS[info.colorType];
  if (
    info.bitDepth !== 8 ||
    info.interlace !== 0 ||
    !channels ||
    info.colorType === 0 ||
    info.colorType === 4
  )
    throw new Error(`unsupported PNG (colour type ${info.colorType}, depth ${info.bitDepth})`);
  const idat = [];
  for (let o = 8; o + 8 <= buf.length;) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'IDAT')
      idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = info.width * channels;
  const data = Buffer.alloc(stride * info.height);
  for (let y = 0; y < info.height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[y * stride + x - channels] : 0;
      const b = y > 0 ? data[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? data[(y - 1) * stride + x - channels] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      data[y * stride + x] = v & 255;
    }
  }
  return { width: info.width, height: info.height, channels, data };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Converts between 3 and 4 channels (adding an opaque alpha channel or dropping it). */
export function withChannels(img, channels) {
  if (img.channels === channels) return img;
  const n = img.width * img.height;
  const data = Buffer.alloc(n * channels);
  for (let i = 0; i < n; i++) {
    data[i * channels] = img.data[i * img.channels];
    data[i * channels + 1] = img.data[i * img.channels + 1];
    data[i * channels + 2] = img.data[i * img.channels + 2];
    if (channels === 4) data[i * channels + 3] = img.channels === 4 ? img.data[i * 4 + 3] : 255;
  }
  return { ...img, channels, data };
}

/** @param {{ width: number, height: number, channels: number, data: Buffer }} img */
export function encodePng(img) {
  const { width, height, channels, data } = img;
  const stride = width * channels;
  const out = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    let best = -1;
    let bestScore = Infinity;
    let bestRow = null;
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const cur = data[y * stride + x];
        const a = x >= channels ? data[y * stride + x - channels] : 0;
        const b = y > 0 ? data[(y - 1) * stride + x] : 0;
        const c = x >= channels && y > 0 ? data[(y - 1) * stride + x - channels] : 0;
        const pred =
          filter === 0
            ? 0
            : filter === 1
              ? a
              : filter === 2
                ? b
                : filter === 3
                  ? (a + b) >> 1
                  : paeth(a, b, c);
        const v = (cur - pred) & 255;
        candidate[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = filter;
        bestRow = Buffer.from(candidate);
      }
    }
    out[y * (stride + 1)] = best;
    bestRow.copy(out, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(out, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Re-encodes a PNG with 3 (no alpha) or 4 (alpha channel) channels. */
export function normalizePng(buf, channels) {
  return encodePng(withChannels(decodePng(buf), channels));
}
