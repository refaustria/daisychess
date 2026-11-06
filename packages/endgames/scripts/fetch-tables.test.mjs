// fetch-tables.mjs with file:// mirrors: download, verification (fail-closed), resume from a
// partial download, --check, --out and the argument parser.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MANIFEST,
  UsageError,
  cacheDir,
  fileName,
  parseArgs,
  readManifest,
  run,
  tableUrl,
} from './fetch-tables.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

let dir;
let mirror;
let cache;
let manifestPath;
const files = {
  'KQvK.rtbw': Buffer.from('wdl-bytes-of-kqvk'),
  'KQvK.rtbz': Buffer.from('dtz-bytes-of-kqvk-longer'),
  'KRPvKR.rtbw': Buffer.alloc(5000, 7),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fetch-tables-'));
  mirror = join(dir, 'mirror');
  cache = join(dir, 'cache');
  mkdirSync(join(mirror, '3-4-5-wdl'), { recursive: true });
  mkdirSync(join(mirror, '3-4-5-dtz-nr'), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(mirror, name.endsWith('w') ? '3-4-5-wdl' : '3-4-5-dtz-nr', name), bytes);
  }
  const entry = (name, kind, pack) => {
    const b = files[`${name}.${kind === 'wdl' ? 'rtbw' : 'rtbz'}`];
    return { name, kind, bytes: b.length, sha256: sha(b), pack };
  };
  manifestPath = join(dir, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      format: 1,
      source: 'test',
      tables: [
        entry('KQvK', 'wdl', 'core'),
        entry('KQvK', 'dtz', 'core'),
        entry('KRPvKR', 'wdl', 'rook'),
      ],
    }),
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const opts = (extra = {}) => ({
  packs: [],
  check: false,
  base: pathToFileURL(mirror).href,
  manifest: manifestPath,
  cache,
  ...extra,
});
const quiet = () => {};

describe('fetch-tables', () => {
  it('downloads and verifies a pack into the cache and copies it flat into --out', async () => {
    const out = join(dir, 'out');
    expect(await run(opts({ packs: ['rook'], out }), quiet)).toBe(0);
    expect(readFileSync(join(cache, 'KRPvKR.rtbw'))).toEqual(files['KRPvKR.rtbw']);
    expect(readFileSync(join(out, 'KRPvKR.rtbw'))).toEqual(files['KRPvKR.rtbw']);
    expect(existsSync(join(cache, 'KQvK.rtbw'))).toBe(false); // other pack untouched
    // --out may be the cache itself (deploy-endgames.sh)
    expect(await run(opts({ packs: ['rook'], out: cache }), quiet)).toBe(0);
  });

  it('fetches every pack by default and keeps verified files on a second run', async () => {
    const log = [];
    expect(await run(opts(), (s) => log.push(s))).toBe(0);
    expect(log.filter((l) => l.includes('downloading'))).toHaveLength(3);
    log.length = 0;
    expect(await run(opts(), (s) => log.push(s))).toBe(0);
    expect(log.filter((l) => l.includes('downloading'))).toHaveLength(0);
  });

  it('fails closed on a sha256 mismatch: nothing is kept or published', async () => {
    writeFileSync(join(mirror, '3-4-5-wdl', 'KRPvKR.rtbw'), Buffer.alloc(5000, 8)); // same size, other bytes
    const out = join(dir, 'out');
    const log = [];
    expect(await run(opts({ packs: ['rook'], out }), (s) => log.push(s))).toBe(1);
    expect(existsSync(join(cache, 'KRPvKR.rtbw'))).toBe(false);
    expect(existsSync(join(cache, 'KRPvKR.rtbw.part'))).toBe(false);
    expect(existsSync(join(out, 'KRPvKR.rtbw'))).toBe(false);
    expect(log.join('\n')).toMatch(/does not match the manifest/);
  });

  it('replaces a corrupted cached file', async () => {
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'KQvK.rtbw'), 'garbage');
    expect(await run(opts({ packs: ['core'] }), quiet)).toBe(0);
    expect(readFileSync(join(cache, 'KQvK.rtbw'))).toEqual(files['KQvK.rtbw']);
  });

  it('resumes a partial download', async () => {
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'KRPvKR.rtbw.part'), files['KRPvKR.rtbw'].subarray(0, 1234));
    const log = [];
    expect(await run(opts({ packs: ['rook'] }), (s) => log.push(s))).toBe(0);
    expect(log.join('\n')).toMatch(/resuming at 1234/);
    expect(readFileSync(join(cache, 'KRPvKR.rtbw'))).toEqual(files['KRPvKR.rtbw']);
    expect(existsSync(join(cache, 'KRPvKR.rtbw.part'))).toBe(false);
  });

  it('restarts a partial download that is longer than the file', async () => {
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'KQvK.rtbw.part'), Buffer.alloc(100, 1));
    expect(await run(opts({ packs: ['core'] }), quiet)).toBe(0);
    expect(readFileSync(join(cache, 'KQvK.rtbw'))).toEqual(files['KQvK.rtbw']);
  });

  it('--check verifies without downloading', async () => {
    expect(await run(opts({ check: true }), quiet)).toBe(1);
    expect(existsSync(join(cache, 'KQvK.rtbw'))).toBe(false);
    expect(await run(opts(), quiet)).toBe(0);
    expect(await run(opts({ check: true }), quiet)).toBe(0);
  });

  it('reports a file missing on the mirror', async () => {
    rmSync(join(mirror, '3-4-5-dtz-nr', 'KQvK.rtbz'));
    const log = [];
    expect(await run(opts({ packs: ['core'] }), (s) => log.push(s))).toBe(1);
    expect(log.join('\n')).toMatch(/not found/);
    expect(existsSync(join(cache, 'KQvK.rtbw'))).toBe(true);
  });

  it('downloads over HTTP, resuming with Range (206) and restarting when Range is ignored (200)', async () => {
    const requests = [];
    let honourRange = true;
    const server = createServer((req, res) => {
      requests.push({ url: req.url, range: req.headers.range });
      const name = req.url.split('/').pop();
      const body = files[name];
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      if (m && honourRange) {
        res
          .writeHead(206, { 'Content-Length': body.length - Number(m[1]) })
          .end(body.subarray(Number(m[1])));
      } else {
        res.writeHead(200, { 'Content-Length': body.length }).end(body);
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/tables`;
    try {
      mkdirSync(cache, { recursive: true });
      writeFileSync(join(cache, 'KRPvKR.rtbw.part'), files['KRPvKR.rtbw'].subarray(0, 1000));
      expect(await run(opts({ packs: ['rook'], base }), quiet)).toBe(0);
      expect(requests.at(-1)).toEqual({
        url: '/tables/3-4-5-wdl/KRPvKR.rtbw',
        range: 'bytes=1000-',
      });
      expect(readFileSync(join(cache, 'KRPvKR.rtbw'))).toEqual(files['KRPvKR.rtbw']);

      honourRange = false;
      writeFileSync(join(cache, 'KQvK.rtbz.part'), files['KQvK.rtbz'].subarray(0, 5));
      expect(await run(opts({ packs: ['core'], base }), quiet)).toBe(0);
      expect(readFileSync(join(cache, 'KQvK.rtbz'))).toEqual(files['KQvK.rtbz']);

      rmSync(join(cache, 'KQvK.rtbw'));
      files['KQvK.rtbw'] = undefined;
      const log = [];
      expect(await run(opts({ packs: ['core'], base }), (s) => log.push(s))).toBe(1);
      expect(log.join('\n')).toMatch(/HTTP 404/);
    } finally {
      files['KQvK.rtbw'] = Buffer.from('wdl-bytes-of-kqvk');
      server.close();
    }
  });

  it('parses arguments and rejects bad ones', () => {
    expect(parseArgs(['--pack', 'rook', '--out', '/x', '--base', 'https://m/'])).toMatchObject({
      packs: ['rook'],
      out: '/x',
      base: 'https://m',
    });
    expect(parseArgs(['--check']).check).toBe(true);
    expect(() => parseArgs(['--pack', 'queen'])).toThrow(UsageError);
    expect(() => parseArgs(['--out'])).toThrow(UsageError);
    expect(() => parseArgs(['--frobnicate'])).toThrow(UsageError);
  });

  it('builds mirror URLs and file names', () => {
    expect(tableUrl('https://m', { name: 'KQvK', kind: 'wdl' })).toBe(
      'https://m/3-4-5-wdl/KQvK.rtbw',
    );
    expect(tableUrl('https://m', { name: 'KRPvKRP', kind: 'dtz' })).toBe(
      'https://m/6-dtz-nr/KRPvKRP.rtbz',
    );
    expect(() => tableUrl('https://m', { name: 'KRPPvKRP', kind: 'wdl' })).toThrow();
    expect(fileName({ name: 'KRPvKR', kind: 'dtz' })).toBe('KRPvKR.rtbz');
  });

  it('uses ENDGAME_CACHE_DIR', () => {
    expect(cacheDir({ ENDGAME_CACHE_DIR: '/c' })).toBe('/c');
    expect(cacheDir({})).toMatch(/\.cache\/daisychess\/endgames$/);
  });

  it('rejects malformed manifests', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(
      bad,
      JSON.stringify({
        format: 1,
        tables: [{ name: '../x', kind: 'wdl', bytes: 1, sha256: 'a'.repeat(64), pack: 'core' }],
      }),
    );
    expect(() => readManifest(bad)).toThrow(/bad manifest entry/);
    writeFileSync(bad, JSON.stringify({ format: 2, tables: [] }));
    expect(() => readManifest(bad)).toThrow(/unsupported/);
  });

  it('reads the committed manifest', () => {
    const m = readManifest(DEFAULT_MANIFEST);
    expect(m.tables.some((t) => t.pack === 'core')).toBe(true);
    expect(m.tables.some((t) => t.pack === 'rook')).toBe(true);
  });
});
