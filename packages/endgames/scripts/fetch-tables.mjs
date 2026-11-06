#!/usr/bin/env node
// Downloads the Syzygy table files named in packages/endgames/tables.manifest.json (ADR-025 §2,
// M32-2) from the lichess mirror into a cache directory, verifies each file's size and sha256
// against the manifest (fail-closed: a mismatching file is deleted, never published) and
// optionally copies the verified files flat into --out.
//
//   node packages/endgames/scripts/fetch-tables.mjs [--pack core|rook]... [--out <dir>]
//        [--check] [--base <url>] [--manifest <file>]
//
//   --pack      pack(s) to fetch (repeatable; default: every pack of the manifest)
//   --out       copy the verified files into this directory (`<NAME>.rtbw|rtbz`, flat); may be
//               the cache directory itself (deploy/deploy-endgames.sh does that)
//   --check     verify the cached files only, download nothing
//   --base      mirror base URL (default https://tablebase.lichess.ovh/tables/standard;
//               file:// URLs are read from disk, for tests)
//   --manifest  manifest path (default: the package's tables.manifest.json)
//
// Environment: ENDGAME_CACHE_DIR (default ~/.cache/daisychess/endgames).
// Downloads resume from `<file>.part` with an HTTP Range request. Exit code 0 when every
// selected file is present and verified, 1 otherwise, 2 for usage errors.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST = join(HERE, '..', 'tables.manifest.json');
export const DEFAULT_BASE = 'https://tablebase.lichess.ovh/tables/standard';
const FILE_TIMEOUT_MS = 10 * 60 * 1000;

export function cacheDir(env = process.env) {
  return env.ENDGAME_CACHE_DIR || join(homedir(), '.cache', 'daisychess', 'endgames');
}

export class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = {
    packs: [],
    out: undefined,
    check: false,
    base: DEFAULT_BASE,
    manifest: DEFAULT_MANIFEST,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === '--pack') {
      const p = next();
      if (p !== 'core' && p !== 'rook') throw new UsageError(`unknown pack ${p} (core|rook)`);
      opts.packs.push(p);
    } else if (a === '--out') opts.out = next();
    else if (a === '--check') opts.check = true;
    else if (a === '--base') opts.base = next().replace(/\/+$/, '');
    else if (a === '--manifest') opts.manifest = next();
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new UsageError(`unknown argument ${a}`);
  }
  return opts;
}

/** Reads and checks the manifest (the same rules as TablesManifestSchema, without zod). */
export function readManifest(path) {
  const m = JSON.parse(readFileSync(path, 'utf8'));
  if (m.format !== 1 || !Array.isArray(m.tables)) throw new Error(`${path}: unsupported manifest`);
  const seen = new Set();
  for (const t of m.tables) {
    const ok =
      typeof t.name === 'string' &&
      /^K[QRBNP]*vK[QRBNP]*$/.test(t.name) &&
      (t.kind === 'wdl' || t.kind === 'dtz') &&
      (t.pack === 'core' || t.pack === 'rook') &&
      Number.isInteger(t.bytes) &&
      t.bytes > 0 &&
      typeof t.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(t.sha256);
    if (!ok) throw new Error(`${path}: bad manifest entry ${JSON.stringify(t)}`);
    const id = `${t.name}.${t.kind}`;
    if (seen.has(id)) throw new Error(`${path}: duplicate entry ${id}`);
    seen.add(id);
  }
  return m;
}

export const fileName = (t) => `${t.name}.${t.kind === 'wdl' ? 'rtbw' : 'rtbz'}`;

/**
 * Mirror URL of a table: WDL from `3-4-5-wdl/`, DTZ from `3-4-5-dtz-nr/` — the DTZ tables
 * regenerated without rounding (values in plies; what tablebase.lichess.ovh answers with), not
 * the original rounded `3-4-5-dtz/`. Six pieces: `6-wdl/`, `6-dtz-nr/`.
 */
export function tableUrl(base, t) {
  const pieces = t.name.length - 1;
  if (pieces > 6) throw new Error(`${t.name}: 7-piece tables are not supported by this script`);
  const kind = t.kind === 'wdl' ? 'wdl' : 'dtz-nr';
  const dir = pieces <= 5 ? `3-4-5-${kind}` : `6-${kind}`;
  return `${base}/${dir}/${fileName(t)}`;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

const sizeOf = (path) => (existsSync(path) ? statSync(path).size : -1);

/** Whether `path` holds exactly the manifest's bytes. */
export async function verified(path, t) {
  if (sizeOf(path) !== t.bytes) return false;
  return (await sha256File(path)) === t.sha256;
}

/** Appends bytes [from, …) of `url` to `part` (truncates first when the server ignores Range). */
async function download(url, part, from) {
  if (url.startsWith('file://')) {
    const src = fileURLToPath(url);
    if (!existsSync(src)) throw new Error(`not found: ${url}`);
    await pipeline(
      createReadStream(src, { start: from }),
      createWriteStream(part, { flags: from > 0 ? 'a' : 'w' }),
    );
    return;
  }
  const headers = { 'User-Agent': 'DaisyChess fetch-tables (daisychess.org)' };
  if (from > 0) headers.Range = `bytes=${from}-`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  if (res.status === 416) return; // already complete
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const append = from > 0 && res.status === 206;
  await pipeline(
    Readable.fromWeb(res.body),
    createWriteStream(part, { flags: append ? 'a' : 'w' }),
  );
}

/**
 * Makes `<cache>/<file>` a verified copy of the manifest entry: keeps a verified file, else
 * downloads (resuming `.part`), verifies and renames. A mismatch deletes the download and throws.
 */
export async function ensureCached(t, { cache, base, check, log = () => {} }) {
  const target = join(cache, fileName(t));
  if (await verified(target, t)) return target;
  if (existsSync(target)) {
    log(`${fileName(t)}: cached file does not match the manifest, removing it`);
    rmSync(target);
  }
  if (check) throw new Error(`${fileName(t)}: missing or unverified in ${cache}`);
  const part = `${target}.part`;
  let from = Math.max(0, sizeOf(part));
  if (from > t.bytes) {
    rmSync(part);
    from = 0;
  }
  const url = tableUrl(base, t);
  log(`${fileName(t)}: downloading ${url}${from > 0 ? ` (resuming at ${from})` : ''}`);
  if (from < t.bytes) await download(url, part, from);
  if (!(await verified(part, t))) {
    rmSync(part, { force: true });
    throw new Error(
      `${fileName(t)}: size or sha256 does not match the manifest (download deleted)`,
    );
  }
  renameSync(part, target);
  return target;
}

/** Copies a verified file into `out` atomically (no-op when `out` is the cache directory). */
function publish(src, out, t) {
  const dest = join(out, fileName(t));
  if (resolve(dest) === resolve(src)) return dest;
  const tmp = `${dest}.tmp-${process.pid}`;
  copyFileSync(src, tmp);
  renameSync(tmp, dest);
  return dest;
}

export async function run(opts, log = (s) => console.error(s)) {
  const manifest = readManifest(opts.manifest);
  const packs = opts.packs.length > 0 ? opts.packs : ['core', 'rook'];
  const entries = manifest.tables.filter((t) => packs.includes(t.pack));
  const cache = opts.cache ?? cacheDir();
  mkdirSync(cache, { recursive: true });
  if (opts.out) mkdirSync(opts.out, { recursive: true });
  let failures = 0;
  let bytes = 0;
  for (const t of entries) {
    try {
      const path = await ensureCached(t, { cache, base: opts.base, check: opts.check, log });
      if (opts.out) publish(path, opts.out, t);
      bytes += t.bytes;
    } catch (e) {
      failures++;
      log(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log(
    `${entries.length - failures}/${entries.length} table files verified (${packs.join(', ')}; ${bytes} bytes)` +
      (opts.out ? ` in ${opts.out}` : ` in ${cache}`),
  );
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
  if (opts.help) {
    const text = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    console.log(
      text
        .slice(
          1,
          text.findIndex((l) => l.startsWith('import')),
        )
        .map((l) => l.replace(/^\/\/ ?/, ''))
        .join('\n'),
    );
    process.exit(0);
  }
  run(opts).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
