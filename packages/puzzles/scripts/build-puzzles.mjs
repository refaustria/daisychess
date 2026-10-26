#!/usr/bin/env node
// Puzzle build pipeline (ADR-023 §4): lichess_db_puzzle.csv.zst -> curated shards + index.json
// (+ the bundled starter set and its SOURCE.md).
//
//   node packages/puzzles/scripts/build-puzzles.mjs --input <file.csv.zst|file.csv> --out <dir>
//        [--starter <path/starter.json>] [--sample <bytes>] [--dry-run] [--sha256 <hex>]
//        [--source <url>] [--last-modified <text>] [--built-at <iso>] [--jobs <n>] [--zstd-cli]
//
// Imports the BUILT package (`pnpm --filter @daisychess/puzzles build` first). Memory: the input is
// streamed twice instead of being held. Pass 1 parses every line, applies the hard filter and the
// chess.js legality check and keeps only what the curation needs (id, rating, rd, popularity,
// plays and an interned theme list, ≈ 150 B per kept row); pass 2 streams the file again and
// materialises the full rows of the curated selection only (≈ 300 k). Every line is decoded from
// its own buffer slice, so retained substrings never pin a whole decompression chunk.
//
// Output (`--out`): shards/<band>-<16 hex of sha256(content)>.json first, index.json last (written
// through a temp file and a rename), so an index never names a missing shard. Every file is
// validated with the package's Zod schemas before it is written. The starter (`--starter`) must
// stay ≤ STARTER_MAX_BYTES; SOURCE.md is written next to it.
//
// --sample <bytes>  reads only the first <bytes> of the input (a ranged partial download); the
//                   truncated end of the zstd stream and the last, partial line are tolerated.
// --dry-run         runs everything and prints the counts, writes nothing.
// --sha256 <hex>    expected digest of the input (fail-closed; not allowed with --sample).
// --zstd-cli        use the `zstd` CLI even when zlib.createZstdDecompress exists (tests).
// Exit codes: 0 ok, 1 failure, 2 usage.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';

export const DEFAULT_SOURCE = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SHARD_MAX_ROWS = 2000;
/** Selection rounds of pass 2 (a round repeats only when the previous one found illegal rows). */
const MAX_ROUNDS = 5;
/** Below this many rows the legality check runs inline (worker start-up is not worth it). */
const MIN_PARALLEL_ROWS = 4000;

/** Worker threads for the legality check: cores − 1, at most 8. */
export const defaultJobs = () => Math.max(1, Math.min(8, availableParallelism() - 1));

const USAGE = `usage: build-puzzles.mjs --input <file.csv.zst|file.csv> (--out <dir> | --dry-run)
       [--starter <starter.json>] [--sample <bytes>] [--sha256 <hex>] [--source <url>]
       [--last-modified <text>] [--built-at <iso>] [--jobs <n>] [--zstd-cli]`;

export class UsageError extends Error {}

/**
 * Command line → options. Throws {@link UsageError}.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {import('./build-puzzles.d.mts').BuildOptions} */
  const o = { input: '', dryRun: false, zstdCli: false };
  const value = (/** @type {number} */ i, /** @type {string} */ flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--input':
        o.input = value(i++, a);
        break;
      case '--out':
        o.out = value(i++, a);
        break;
      case '--starter':
        o.starter = value(i++, a);
        break;
      case '--sample': {
        const v = value(i++, a);
        if (!/^[1-9]\d*$/.test(v)) throw new UsageError('--sample needs a positive byte count');
        o.sample = Number(v);
        break;
      }
      case '--sha256': {
        const v = value(i++, a).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(v)) throw new UsageError('--sha256 needs 64 hex digits');
        o.sha256 = v;
        break;
      }
      case '--source':
        o.source = value(i++, a);
        break;
      case '--last-modified':
        o.lastModified = value(i++, a);
        break;
      case '--built-at':
        o.builtAt = value(i++, a);
        break;
      case '--jobs': {
        const v = value(i++, a);
        if (!/^[1-9]\d?$/.test(v)) throw new UsageError('--jobs needs 1…99');
        o.jobs = Number(v);
        break;
      }
      case '--dry-run':
        o.dryRun = true;
        break;
      case '--zstd-cli':
        o.zstdCli = true;
        break;
      case '--help':
      case '-h':
        throw new UsageError(USAGE);
      default:
        throw new UsageError(`unknown argument ${a}\n${USAGE}`);
    }
  }
  if (!o.input) throw new UsageError(`--input is required\n${USAGE}`);
  if (!o.out && !o.dryRun) throw new UsageError(`--out is required (or --dry-run)\n${USAGE}`);
  if (o.sha256 && o.sample) throw new UsageError('--sha256 cannot verify a --sample read');
  return o;
}

/** sha256 (hex) of the first `limit` bytes of a file. */
export async function hashFile(/** @type {string} */ path, /** @type {number} */ limit) {
  const hash = createHash('sha256');
  if (limit > 0) {
    for await (const chunk of createReadStream(path, { end: limit - 1 })) hash.update(chunk);
  }
  return hash.digest('hex');
}

function isZstd(/** @type {string} */ path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(4);
    const n = readSync(fd, head, 0, 4, 0);
    // A zstd frame, or a skippable frame (0x184D2A50…5F; the lichess dumps start with one).
    return (
      n === 4 &&
      (head.equals(ZSTD_MAGIC) ||
        (head[3] === 0x18 && head[2] === 0x4d && head[1] === 0x2a && (head[0] & 0xf0) === 0x50))
    );
  } finally {
    closeSync(fd);
  }
}

/** The decompressor: zlib when available (Node ≥ 22.15), else the `zstd` CLI. */
function decompress(
  /** @type {import('node:stream').Readable} */ src,
  /** @type {boolean} */ forceCli,
) {
  if (!forceCli && typeof zlib.createZstdDecompress === 'function') {
    const dec = zlib.createZstdDecompress();
    src.on('error', (e) => dec.destroy(e));
    src.pipe(dec);
    return { stream: dec, done: async () => {}, abort: () => (src.destroy(), dec.destroy()) };
  }
  const child = spawn('zstd', ['-d', '-c', '-q'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s) => (stderr = (stderr + s).slice(-2000)));
  // EPIPE when zstd dies early: the exit code below reports it.
  child.stdin.on('error', () => {});
  src.on('error', (e) => child.stdout.destroy(e));
  src.pipe(child.stdin);
  /** @type {Promise<number>} */
  const exited = new Promise((res, rej) => {
    child.on('error', (e) =>
      rej(
        /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT'
          ? new Error('zstd CLI not found and zlib.createZstdDecompress is unavailable')
          : e,
      ),
    );
    child.on('close', (code) => res(code ?? 1));
  });
  // Keep the rejection observed even when the stream fails first.
  exited.catch(() => {});
  return {
    stream: child.stdout,
    done: async () => {
      const code = await exited;
      if (code !== 0) throw new Error(`zstd exited with ${code}: ${stderr.trim()}`);
    },
    abort: () => {
      src.destroy();
      if (child.exitCode === null) child.kill();
    },
  };
}

/**
 * Streams the lines of a CSV or CSV.zst file to `onLine` (no line terminator, `\r` dropped).
 * With `sample`, only the first `sample` bytes are read: a decompression error at the truncated
 * end is tolerated and the last line, which may be cut, is dropped. Returns the bytes read and
 * whether the read was partial.
 * @param {string} path
 * @param {{ sample?: number, zstdCli?: boolean }} opts
 * @param {(line: string) => void} onLine
 */
export async function streamLines(path, opts, onLine) {
  const size = statSync(path).size;
  const limit = opts.sample ? Math.min(opts.sample, size) : size;
  let partial = limit < size;
  if (limit === 0) return { bytes: 0, partial };
  const src = createReadStream(path, { end: limit - 1 });
  const { stream, done, abort } = isZstd(path)
    ? decompress(src, opts.zstdCli === true)
    : { stream: src, done: async () => {}, abort: () => src.destroy() };
  /** An error thrown by `onLine` always propagates (only stream errors are tolerated). */
  let lineError = false;

  /** @type {Buffer | null} */
  let rest = null;
  const emit = (/** @type {Buffer} */ buf, /** @type {number} */ a, /** @type {number} */ b) => {
    const end = b > a && buf[b - 1] === 13 ? b - 1 : b;
    try {
      onLine(buf.toString('utf8', a, end));
    } catch (e) {
      lineError = true;
      throw e;
    }
  };
  try {
    for await (const chunk of stream) {
      const buf = rest ? Buffer.concat([rest, chunk]) : /** @type {Buffer} */ (chunk);
      let start = 0;
      let nl;
      while ((nl = buf.indexOf(10, start)) !== -1) {
        emit(buf, start, nl);
        start = nl + 1;
      }
      rest = start < buf.length ? buf.subarray(start) : null;
    }
    await done();
  } catch (e) {
    if (lineError || !opts.sample) {
      abort();
      throw e;
    }
    // The ranged sample ends inside a zstd frame: everything up to here was decoded.
    partial = true;
  }
  if (rest && rest.length > 0 && !partial) {
    try {
      emit(rest, 0, rest.length);
    } catch (e) {
      abort();
      throw e;
    }
  }
  return { bytes: limit, partial };
}

/** @typedef {import('../dist/index.js').CsvPuzzle} CsvPuzzle */

/** The package, from `dist/` (built by `pnpm --filter @daisychess/puzzles build`). */
async function loadPackage() {
  try {
    return await import('../dist/index.js');
  } catch (e) {
    throw new Error(
      `cannot load packages/puzzles/dist (run \`pnpm --filter @daisychess/puzzles build\` first): ${/** @type {Error} */ (e).message}`,
    );
  }
}

/**
 * Indexes of the rows whose line is not legal (chess.js), checked in `jobs` worker threads.
 * @param {CsvPuzzle[]} rows
 * @param {number} jobs
 * @returns {Promise<Set<number>>}
 */
export async function illegalRows(rows, jobs) {
  const items = rows.map((p) => [p.fen, p.moves.join(' ')]);
  if (jobs <= 1 || items.length < MIN_PARALLEL_ROWS) {
    const P = await loadPackage();
    return new Set(legalityScan(P.lineIsLegal, items, 0));
  }
  const per = Math.ceil(items.length / jobs);
  /** @type {Worker[]} */
  const workers = [];
  try {
    const parts = await Promise.all(
      Array.from({ length: Math.ceil(items.length / per) }, (_, k) => {
        const w = new Worker(fileURLToPath(import.meta.url), {
          workerData: {
            kind: 'legality',
            items: items.slice(k * per, (k + 1) * per),
            offset: k * per,
          },
        });
        workers.push(w);
        return /** @type {Promise<number[]>} */ (
          new Promise((res, rej) => {
            w.once('message', res);
            w.once('error', rej);
            w.once('exit', (code) => rej(new Error(`legality worker exited with ${code}`)));
          })
        );
      }),
    );
    return new Set(parts.flat());
  } finally {
    for (const w of workers) void w.terminate();
  }
}

/** @param {(fen: string, moves: string[]) => boolean} isLegal @param {string[][]} items @param {number} offset */
function legalityScan(isLegal, items, offset) {
  /** @type {number[]} */
  const bad = [];
  items.forEach(([fen, moves], i) => {
    if (!isLegal(/** @type {string} */ (fen), (moves ?? '').split(' '))) bad.push(offset + i);
  });
  return bad;
}

const sha256Hex = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');

/** Writes through a temp file and a rename (readers never see a half-written file). */
function writeAtomic(/** @type {string} */ path, /** @type {string} */ content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * The whole build. Returns the summary (counts, files, starter size); writes nothing with
 * `dryRun`. Throws on any failed check (digest, header, consistency, schema, starter size).
 * @param {import('./build-puzzles.d.mts').BuildOptions} o
 * @param {(line: string) => void} [log]
 */
export async function buildPuzzles(o, log = console.log) {
  const P = await loadPackage();
  const input = resolve(o.input);
  const size = statSync(input).size;
  const limit = o.sample ? Math.min(o.sample, size) : size;
  const t0 = Date.now();

  const sha256 = await hashFile(input, limit);
  if (o.sha256 && o.sha256 !== sha256) {
    throw new Error(`sha256 mismatch: ${input} is ${sha256}, expected ${o.sha256}`);
  }
  log(
    `input ${input}: ${limit} bytes${limit < size ? ` (sample of ${size})` : ''}, sha256 ${sha256}`,
  );

  // Pass 1: validate and hard-filter every row; keep the curation fields only.
  /** @type {Record<string, number>} */
  const rejects = {};
  let lines = 0;
  let headerSeen = false;
  /** @type {CsvPuzzle[]} */
  let kept = [];
  /** @type {Map<string, string[]>} */
  const themeSets = new Map();
  /** @type {Map<string, string>} */
  const themeNames = new Map();
  /** @type {string[]} */
  const none = [];
  Object.freeze(none);
  const internThemes = (/** @type {string[]} */ themes) => {
    const key = themes.join(' ');
    let set = themeSets.get(key);
    if (!set) {
      set = themes.map((t) => {
        const name = themeNames.get(t) ?? t;
        themeNames.set(name, name);
        return name;
      });
      Object.freeze(set);
      themeSets.set(key, set);
    }
    return set;
  };
  const reject = (/** @type {string} */ reason) => (rejects[reason] = (rejects[reason] ?? 0) + 1);
  const expectedHeader = P.CSV_COLUMNS.join(',');

  const pass1 = await streamLines(input, o, (line) => {
    lines++;
    if (lines === 1) {
      if (line !== expectedHeader) {
        throw new Error(`unexpected header (format change?): ${line.slice(0, 200)}`);
      }
      headerSeen = true;
      return;
    }
    if (line === '') return reject('empty');
    const r = P.rowFromCsv(line, { checkLegality: false });
    if (!r.ok) return reject(r.reason);
    const p = r.puzzle;
    if (!P.hardFilter(p)) return reject('filtered');
    kept.push({
      id: p.id,
      fen: '',
      moves: none,
      rating: p.rating,
      rd: p.rd,
      popularity: p.popularity,
      nbPlays: p.nbPlays,
      themes: internThemes(p.themes),
      openings: none,
      game: '',
    });
  });
  if (!headerSeen) throw new Error('empty input');
  const rows = lines - 1;
  log(
    `pass 1: ${rows} rows, ${kept.length} pass the hard filter (${fmtCounts(rejects)}), ${secs(t0)}`,
  );

  // Pass 2 (repeated only if illegal rows turn up): select, fetch the full rows of the selection,
  // check their legality with chess.js (≈ 1 ms per line, so only for selected rows, in worker
  // threads), drop illegal rows and select again until the selection is all legal. Rows that are
  // not selected cannot change the selection, so the result equals "filter everything, then select".
  /** @type {Map<string, CsvPuzzle>} */
  const full = new Map();
  let illegal = 0;
  let checked = 0;
  /** @type {CsvPuzzle[]} */
  let curatedMeta = [];
  for (let round = 1; ; round++) {
    if (round > MAX_ROUNDS)
      throw new Error(`selection still had illegal rows after ${MAX_ROUNDS} rounds`);
    curatedMeta = P.selectCurated(kept, { quotaPerBand: 16_000, themeFloor: 600 });
    const need = new Set(curatedMeta.filter((p) => !full.has(p.id)).map((p) => p.id));
    if (need.size === 0) break;
    /** @type {CsvPuzzle[]} */
    const fetched = [];
    let lines2 = 0;
    await streamLines(input, o, (line) => {
      lines2++;
      const comma = line.indexOf(',');
      const id = comma > 0 ? line.slice(0, comma) : '';
      if (!need.has(id)) return;
      need.delete(id);
      const r = P.rowFromCsv(line, { checkLegality: false });
      if (!r.ok) throw new Error(`pass 2: row ${id} no longer valid (${r.reason}); input changed?`);
      fetched.push(r.puzzle);
    });
    if (lines2 !== lines || need.size > 0) {
      throw new Error(
        `pass 2 read ${lines2} lines (pass 1: ${lines}) and missed ${need.size} selected rows; input changed?`,
      );
    }
    const bad = await illegalRows(fetched, o.jobs ?? defaultJobs());
    checked += fetched.length;
    illegal += bad.size;
    fetched.forEach((p, i) => {
      if (!bad.has(i)) full.set(p.id, p);
    });
    log(`pass 2 round ${round}: ${fetched.length} rows fetched, ${bad.size} illegal, ${secs(t0)}`);
    if (bad.size === 0) break;
    const drop = new Set([...bad].map((i) => /** @type {CsvPuzzle} */ (fetched[i]).id));
    kept = kept.filter((p) => !drop.has(p.id));
  }
  kept = [];
  if (illegal > 0) rejects.illegal = illegal;
  if ((await hashFile(input, limit)) !== sha256) throw new Error('input changed during the build');
  const curated = curatedMeta.map((p) => /** @type {CsvPuzzle} */ (full.get(p.id)));
  full.clear();
  log(
    `pass 2: ${curated.length} curated puzzles (${checked} legality checks, ${illegal} illegal), ${secs(t0)}`,
  );

  // Shards, then the index.
  const dict = P.buildDictionary(curated);
  const drafts = P.shardByBand(curated, dict, { maxRows: SHARD_MAX_ROWS });
  /** @type {import('../dist/index.js').WrittenShard[]} */
  const written = [];
  /** @type {{ file: string, json: string }[]} */
  const files = [];
  for (const d of drafts) {
    const shard = P.ShardSchema.parse({
      format: P.PUZZLE_FORMAT,
      dataset: sha256,
      band: d.band,
      rows: d.rows,
    });
    const json = JSON.stringify(shard);
    const file = `shards/${d.band}-${sha256Hex(json).slice(0, 16)}.json`;
    written.push({ ...d, file, bytes: Buffer.byteLength(json) });
    files.push({ file, json });
  }
  const index = P.PuzzleIndexSchema.parse(
    P.buildIndex({
      dataset: {
        source: o.source ?? DEFAULT_SOURCE,
        sha256,
        lastModified: o.lastModified ?? statSync(input).mtime.toUTCString(),
        builtAt: o.builtAt ?? new Date().toISOString(),
      },
      dictionary: dict,
      shards: written,
    }),
  );
  const indexJson = JSON.stringify(index);

  // Starter + daily pool.
  const starterRows = P.pickStarter(curated);
  const daily = P.pickDailyPool(starterRows);
  const starter = P.StarterSchema.parse(
    P.buildStarter({ dataset: sha256, puzzles: starterRows, daily }),
  );
  const starterJson = JSON.stringify(starter);
  const starterBytes = Buffer.byteLength(starterJson);
  if (starterBytes > P.STARTER_MAX_BYTES) {
    throw new Error(`starter is ${starterBytes} bytes, limit ${P.STARTER_MAX_BYTES}`);
  }

  const summary = {
    sha256,
    bytes: limit,
    partial: pass1.partial,
    rows,
    hardFiltered: rows - Object.values(rejects).reduce((a, b) => a + b, 0) + illegal,
    legalityChecked: checked,
    rejects,
    curated: curated.length,
    shards: written.map((s) => ({
      file: s.file,
      band: s.band,
      count: s.rows.length,
      bytes: s.bytes,
    })),
    shardBytes: written.reduce((n, s) => n + s.bytes, 0),
    indexBytes: Buffer.byteLength(indexJson),
    starter: { rows: starterRows.length, daily: daily.length, bytes: starterBytes },
    perBand: countBy(curated, (p) => [P.bandOf(p.rating)]),
    perTheme: countBy(curated, (p) => p.themes),
    starterPerTheme: countBy(starterRows, (p) => p.themes),
    maxRssMb: 0,
    seconds: 0,
  };

  if (!o.dryRun && o.out) {
    const out = resolve(o.out);
    for (const f of files) writeAtomic(join(out, f.file), f.json);
    writeAtomic(join(out, 'index.json'), indexJson);
    log(`wrote ${files.length} shards + index.json to ${out}`);
  }
  if (!o.dryRun && o.starter) {
    const path = resolve(o.starter);
    writeAtomic(path, starterJson);
    writeAtomic(join(dirname(path), 'SOURCE.md'), sourceMd({ ...o, sha256, index, summary }));
    log(`wrote ${path} (${starterBytes} bytes) and SOURCE.md`);
  }

  summary.maxRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
  summary.seconds = Math.round((Date.now() - t0) / 1000);
  printSummary(summary, log);
  return summary;
}

/** @template T @param {T[]} items @param {(t: T) => (string | number)[]} keys */
function countBy(items, keys) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const it of items) for (const k of keys(it)) out[k] = (out[k] ?? 0) + 1;
  return out;
}

const secs = (/** @type {number} */ t0) => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const fmtCounts = (/** @type {Record<string, number>} */ c) =>
  Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ') || 'no rejects';

/**
 * @param {Awaited<ReturnType<typeof buildPuzzles>>} s
 * @param {(line: string) => void} log
 */
function printSummary(s, log) {
  log('');
  log(`rows ${s.rows}, hard filter ${s.hardFiltered}, curated ${s.curated}`);
  log(
    `shards ${s.shards.length} (${(s.shardBytes / 1e6).toFixed(1)} MB), index ${s.indexBytes} bytes`,
  );
  log(`starter ${s.starter.rows} rows, daily pool ${s.starter.daily}, ${s.starter.bytes} bytes`);
  log('per band (curated):');
  for (const [band, n] of Object.entries(s.perBand).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    log(`  ${band.padStart(4)}  ${String(n).padStart(6)}`);
  }
  log('per theme (curated / starter):');
  for (const [theme, n] of Object.entries(s.perTheme).sort((a, b) => b[1] - a[1])) {
    log(
      `  ${theme.padEnd(22)} ${String(n).padStart(7)} ${String(s.starterPerTheme[theme] ?? 0).padStart(6)}`,
    );
  }
  log(`peak RSS ${s.maxRssMb} MB, ${s.seconds} s`);
}

/** SOURCE.md next to the committed starter (same pattern as the openings table). */
function sourceMd(
  /** @type {import('./build-puzzles.d.mts').BuildOptions & { sha256: string, index: import('../dist/index.js').PuzzleIndex, summary: { rows: number, curated: number, starter: { rows: number, daily: number, bytes: number }, partial: boolean, bytes: number } }} */ x,
) {
  const d = x.index.dataset;
  const sample = x.sample
    ? `\n**Sample build**: only the first ${x.summary.bytes} bytes of the dump were read (\`--sample\`); the digest below is of those bytes. Replace with a full run (\`deploy/deploy-puzzles.sh\`).\n`
    : '';
  return `# Puzzle starter set: source

Generated by \`packages/puzzles/scripts/build-puzzles.mjs\` (ADR-023 §4); do not edit by hand.
Regenerate with \`deploy/deploy-puzzles.sh\` after a new monthly lichess dump.
${sample}
| | |
| --- | --- |
| Source | <${d.source}> (lichess.org puzzle database, CC0-1.0) |
| sha256 | \`${d.sha256}\` |
| Last-Modified | ${d.lastModified} |
| Built | ${d.builtAt} |
| Rows read | ${x.summary.rows} |
| Curated (shards) | ${x.summary.curated} |
| Starter rows | ${x.summary.starter.rows} (daily pool ${x.summary.starter.daily}) |
| Starter size | ${x.summary.starter.bytes} bytes |

Licence: the lichess puzzle database is released under CC0 1.0 (public domain dedication),
<https://database.lichess.org/#puzzles>.
`;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(/** @type {Error} */ (e).message);
    process.exit(2);
  }
  try {
    await buildPuzzles(opts);
  } catch (e) {
    console.error(`build-puzzles: ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
}

if (!isMainThread && workerData?.kind === 'legality') {
  const P = await loadPackage();
  parentPort?.postMessage(legalityScan(P.lineIsLegal, workerData.items, workerData.offset));
} else if (
  isMainThread &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main();
}
