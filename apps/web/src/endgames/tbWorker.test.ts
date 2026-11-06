// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MANIFEST_FILES } from './tablePacks';
import { createTbWorkerHandler, sha256Hex, sha256HexSync, verifyTableBytes } from './tbWorker';

const dir = new URL('../../public/endgames/v1/', import.meta.url);
const file = (name: string) => new Uint8Array(readFileSync(new URL(name, dir)));
const diskFetch = async (url: string) => {
  const name = url.split('/').pop()!;
  try {
    return new Response(file(name));
  } catch {
    return new Response('', { status: 404 });
  }
};
const meta = (name: string) => {
  const e = MANIFEST_FILES.get(name)!;
  return { name, sha256: e.sha256, size: e.bytes };
};
const nodeSha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('sha256', () => {
  it('matches node:crypto at block boundaries and for a real table', async () => {
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_001]) {
      const b = new Uint8Array(randomBytes(n));
      expect(sha256HexSync(b), `n=${n}`).toBe(nodeSha(b));
      expect(await sha256Hex(b)).toBe(nodeSha(b));
    }
    const kbn = file('KBNvK.rtbz');
    expect(sha256HexSync(kbn)).toBe(MANIFEST_FILES.get('KBNvK.rtbz')!.sha256);
    // A view into a larger buffer hashes only its own bytes.
    const big = new Uint8Array(100).fill(1);
    expect(sha256HexSync(big.subarray(10, 20))).toBe(nodeSha(big.subarray(10, 20)));
    expect(await sha256Hex(big.subarray(10, 20))).toBe(nodeSha(big.subarray(10, 20)));
  });

  it('verifyTableBytes checks the size and the digest', async () => {
    const kqk = file('KQvK.rtbw');
    const m = meta('KQvK.rtbw');
    expect(await verifyTableBytes(m, kqk)).toBe(true);
    expect(await verifyTableBytes({ ...m, size: m.size + 1 }, kqk)).toBe(false);
    const flipped = kqk.slice();
    flipped[100] = flipped[100]! ^ 1;
    expect(await verifyTableBytes(m, flipped)).toBe(false);
  });
});

describe('createTbWorkerHandler', () => {
  const KQK = '8/8/8/8/8/2k5/8/KQ6 w - - 0 1';

  it('loads bundled files by URL and probes', async () => {
    const handle = createTbWorkerHandler({ fetch: diskFetch });
    expect(await handle({ type: 'probe', id: 1, fen: KQK })).toEqual({
      type: 'result',
      id: 1,
      pos: null,
    });
    const loaded = await handle({
      type: 'load',
      id: 2,
      files: ['KQvK.rtbw', 'KQvK.rtbz'].map((n) => ({ ...meta(n), url: `http://x/${n}` })),
    });
    expect(loaded).toEqual({
      type: 'loaded',
      id: 2,
      loaded: ['KQvK.rtbw', 'KQvK.rtbz'],
      failed: [],
    });
    const res = await handle({ type: 'probe', id: 3, fen: KQK });
    expect(res.type).toBe('result');
    const pos = res.type === 'result' ? res.pos : null;
    expect(pos?.category).toBe('win');
    expect(pos?.dtz).toBeGreaterThan(0);
    expect(pos?.moves.length).toBeGreaterThan(5);
    // Loading again is a no-op that reports the files as loaded.
    const again = await handle({
      type: 'load',
      id: 4,
      files: [{ ...meta('KQvK.rtbw'), url: 'http://x/none' }],
    });
    expect(again).toMatchObject({ loaded: ['KQvK.rtbw'], failed: [] });
  });

  it('accepts transferred bytes', async () => {
    const handle = createTbWorkerHandler({ fetch: () => Promise.reject(new Error('no network')) });
    const b = file('KRvK.rtbw');
    const res = await handle({
      type: 'load',
      id: 1,
      files: [
        { ...meta('KRvK.rtbw'), bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) },
      ],
    });
    expect(res).toMatchObject({ loaded: ['KRvK.rtbw'], failed: [] });
    const p = await handle({ type: 'probe', id: 2, fen: '8/8/8/8/8/2k5/8/KR6 w - - 0 1' });
    expect(p.type === 'result' && p.pos?.category).toBe('win');
  });

  it('fails closed: a wrong digest, a non-table and a failed fetch are never added', async () => {
    const handle = createTbWorkerHandler({ fetch: diskFetch });
    const tampered = file('KQvK.rtbw').slice();
    tampered[50] = tampered[50]! ^ 0xff;
    const garbage = new Uint8Array(64).fill(3);
    const res = await handle({
      type: 'load',
      id: 1,
      files: [
        { ...meta('KQvK.rtbw'), bytes: tampered.buffer },
        { name: 'KRvK.rtbw', size: 64, sha256: nodeSha(garbage), bytes: garbage.buffer },
        { ...meta('KPvK.rtbw'), url: 'http://x/missing-file' },
      ],
    });
    expect(res).toEqual({
      type: 'loaded',
      id: 1,
      loaded: [],
      failed: [
        { name: 'KQvK.rtbw', reason: 'integrity' },
        { name: 'KRvK.rtbw', reason: 'format' },
        { name: 'KPvK.rtbw', reason: 'fetch' },
      ],
    });
    const p = await handle({ type: 'probe', id: 2, fen: KQK });
    expect(p).toEqual({ type: 'result', id: 2, pos: null });
  });

  it('answers null for invalid or ineligible FENs', async () => {
    const handle = createTbWorkerHandler({ fetch: diskFetch });
    expect(await handle({ type: 'probe', id: 1, fen: 'not a fen' })).toEqual({
      type: 'result',
      id: 1,
      pos: null,
    });
    expect(await handle({ type: 'probe', id: 2, fen: 'r3k3/8/8/8/8/8/8/4K2R w Kq - 0 1' })).toEqual(
      { type: 'result', id: 2, pos: null },
    );
  });
});
