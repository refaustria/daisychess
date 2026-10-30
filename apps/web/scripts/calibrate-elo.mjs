#!/usr/bin/env node
// Elo fallback calibration (ADR-024 §5, M31-8): a lichess monthly database PGN (.pgn.zst or .pgn)
// -> apps/web/src/review/data/eloCalibration.json (+ SOURCE.md next to it).
//
//   node apps/web/scripts/calibrate-elo.mjs --input <file.pgn.zst|file.pgn> (--out <json> | --dry-run)
//        [--month <YYYY-MM|provisional>] [--limit <games>] [--sample <bytes>] [--sha256 <hex>]
//        [--source <url>] [--dump-sha256 <hex>] [--min-samples <n>] [--max-knots <n>]
//        [--openings <openings.json>] [--jobs <n>] [--built-at <iso>] [--zstd-cli]
//
// No engine runs: only games that lichess already evaluated (`[%eval …]` after every move, ≈ 6 %
// of a dump) are used. Per game: rated standard game (no casual, no variant, no setup position),
// both ratings present with a RatingDiff (lichess omits it for provisional ratings), not
// abandoned. The game is replayed with chess.js; the review of the live app is reproduced with
// the BUILT `@daisychess/engine-core` (`reviewGame` = the same win-probability sigmoid and
// classification, `selectEloPlies` = the same position selection as the live estimate: after the
// book, not forced, mover win probability 10…90 %, ≥ 10 positions, decimated to 30). The book end
// is found exactly like `review/openingFocus.ts` (move-order prefix of a named line in
// `openings.json`, or a transposition into a named position). Each side with a selection gives
// one sample (mean win-probability loss, the player's rating). Per speed class
// (`speedClass(TimeControl)`, lichess's rule) and for all samples pooled (`unknown`), rating is
// fitted on mean loss by an isotonic (non-increasing) regression — pool-adjacent-violators —
// decimated to ≤ `--max-knots` (24) knots of equal sample weight; the residual standard deviation
// of the interpolated curve is stored. A speed class with fewer than `--min-samples` samples is
// omitted (the app falls back to `unknown`). The table is validated with `EloCalibrationSchema`.
//
// Decompression: `zlib.createZstdDecompress` (Node ≥ 22.15), else the `zstd` CLI (child process;
// `apt install zstd`). `--zstd-cli` forces the CLI (tests).
// --sample <bytes>  reads only the first <bytes> of the input (a ranged partial download); the
//                   truncated end of the zstd stream and the last, partial game are dropped.
// --limit <games>   stops after this many evaluated, eligible games were analysed.
// --sha256 <hex>    expected digest of the input (fail-closed; not allowed with --sample).
// --dump-sha256     digest of the whole dump as lichess lists it (recorded in SOURCE.md only;
//                   for a ranged run, whose own bytes cannot be checked against it).
// --jobs <n>        worker threads replaying games (default cores − 1, at most 8; 1 = inline).
// Exit codes: 0 ok, 1 failure, 2 usage.
//
// Imports the BUILT engine-core (`pnpm --filter @daisychess/engine-core build` first).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';
import { Chess } from 'chess.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OPENINGS = resolve(here, '../src/openings/data/openings.json');
export const DEFAULT_MIN_SAMPLES = 1000;
export const DEFAULT_MAX_KNOTS = 24;
/** Games per worker message. */
const BATCH_GAMES = 200;
/** The start position's eval (White POV); lichess annotates evals after moves only. */
export const START_EVAL = Object.freeze({ cp: 20 });
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Speed classes in the table, in output order (`unknown` = every sample pooled). */
export const SPEED_ORDER = /** @type {const} */ (['bullet', 'blitz', 'rapid', 'classical']);

/** Worker threads: cores − 1, at most 8. */
export const defaultJobs = () => Math.max(1, Math.min(8, availableParallelism() - 1));

const USAGE = `usage: calibrate-elo.mjs --input <file.pgn.zst|file.pgn> (--out <eloCalibration.json> | --dry-run)
       [--month <YYYY-MM|provisional>] [--limit <games>] [--sample <bytes>] [--sha256 <hex>]
       [--source <url>] [--dump-sha256 <hex>] [--min-samples <n>] [--max-knots <n>]
       [--openings <openings.json>] [--jobs <n>] [--built-at <iso>] [--zstd-cli]`;

export class UsageError extends Error {}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Command line → options. Throws {@link UsageError}.
 * @param {string[]} argv
 * @returns {import('./calibrate-elo.d.mts').CalibrateOptions}
 */
export function parseArgs(argv) {
  /** @type {import('./calibrate-elo.d.mts').CalibrateOptions} */
  const o = { input: '', dryRun: false, zstdCli: false };
  const value = (/** @type {number} */ i, /** @type {string} */ flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  const positive = (/** @type {string} */ v, /** @type {string} */ flag) => {
    if (!/^[1-9]\d*$/.test(v)) throw new UsageError(`${flag} needs a positive integer`);
    return Number(v);
  };
  const hex = (/** @type {string} */ v, /** @type {string} */ flag) => {
    const h = v.toLowerCase();
    if (!HEX64.test(h)) throw new UsageError(`${flag} needs 64 hex digits`);
    return h;
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
      case '--month': {
        const v = value(i++, a);
        if (!/^(\d{4}-(0[1-9]|1[0-2])|provisional)$/.test(v)) {
          throw new UsageError('--month needs YYYY-MM or provisional');
        }
        o.month = v;
        break;
      }
      case '--limit':
        o.limit = positive(value(i++, a), a);
        break;
      case '--sample':
        o.sample = positive(value(i++, a), a);
        break;
      case '--sha256':
        o.sha256 = hex(value(i++, a), a);
        break;
      case '--dump-sha256':
        o.dumpSha256 = hex(value(i++, a), a);
        break;
      case '--source':
        o.source = value(i++, a);
        break;
      case '--min-samples':
        o.minSamples = positive(value(i++, a), a);
        break;
      case '--max-knots': {
        const n = positive(value(i++, a), a);
        if (n < 2 || n > 32) throw new UsageError('--max-knots needs 2…32');
        o.maxKnots = n;
        break;
      }
      case '--openings':
        o.openings = value(i++, a);
        break;
      case '--jobs': {
        const n = positive(value(i++, a), a);
        if (n > 64) throw new UsageError('--jobs needs 1…64');
        o.jobs = n;
        break;
      }
      case '--built-at':
        o.builtAt = value(i++, a);
        break;
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

/** `YYYY-MM` from a lichess dump name (`lichess_db_standard_rated_2026-09.pgn.zst`). */
export function monthFromName(/** @type {string} */ path) {
  const m = /_(\d{4}-(?:0[1-9]|1[0-2]))\.pgn(?:\.zst)?$/.exec(basename(path));
  return m ? m[1] : undefined;
}

// --- input ---------------------------------------------------------------------------------------

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
  // EPIPE when zstd dies early (or is killed on --limit): the exit code below reports it.
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
 * The lines of a PGN or PGN.zst file (no terminator, `\r` dropped), as an async iterator that
 * pulls the stream only as fast as the consumer awaits (backpressure). With `sample`, only the
 * first `sample` bytes are read: a decompression error at the truncated end is tolerated and
 * the last, possibly cut line is dropped. `info.partial` is set when the read was partial.
 * Breaking out of the loop aborts the stream (and kills a `zstd` child).
 * @param {string} path
 * @param {{ sample?: number, zstdCli?: boolean }} opts
 * @param {{ bytes: number, partial: boolean }} info
 * @returns {AsyncGenerator<string>}
 */
export async function* readLines(path, opts, info) {
  const size = statSync(path).size;
  const limit = opts.sample ? Math.min(opts.sample, size) : size;
  info.bytes = limit;
  info.partial = limit < size;
  if (limit === 0) return;
  const src = createReadStream(path, { end: limit - 1 });
  const { stream, done, abort } = isZstd(path)
    ? decompress(src, opts.zstdCli === true)
    : { stream: src, done: async () => {}, abort: () => src.destroy() };
  const decode = (/** @type {Buffer} */ buf, /** @type {number} */ a, /** @type {number} */ b) =>
    buf.toString('utf8', a, b > a && buf[b - 1] === 13 ? b - 1 : b);
  let finished = false;
  /** @type {Buffer | null} */
  let rest = null;
  try {
    try {
      for await (const chunk of stream) {
        const buf = rest ? Buffer.concat([rest, chunk]) : /** @type {Buffer} */ (chunk);
        let start = 0;
        let nl;
        while ((nl = buf.indexOf(10, start)) !== -1) {
          yield decode(buf, start, nl);
          start = nl + 1;
        }
        rest = start < buf.length ? Buffer.from(buf.subarray(start)) : null;
      }
      await done();
    } catch (e) {
      if (!opts.sample) throw e;
      // The ranged sample ends inside a zstd frame: everything up to here was decoded.
      info.partial = true;
    }
    if (rest && rest.length > 0 && !info.partial) yield decode(rest, 0, rest.length);
    finished = true;
  } finally {
    if (!finished) abort();
  }
}

// --- PGN -----------------------------------------------------------------------------------------

/**
 * Splits a line stream into games: `push(line)` returns the previous game when a new `[Event`
 * starts; `flush()` returns the last one. A game is `{ tags, movetext }`.
 */
export function createGameSplitter() {
  /** @type {Record<string, string>} */
  let tags = {};
  /** @type {string[]} */
  let moves = [];
  let any = false;
  const take = () => {
    const g = any ? { tags, movetext: moves.join(' ') } : undefined;
    tags = {};
    moves = [];
    any = false;
    return g;
  };
  return {
    /** @param {string} line */
    push(line) {
      /** @type {{ tags: Record<string, string>, movetext: string } | undefined} */
      let out;
      if (line.startsWith('[Event ') && any) out = take();
      if (line === '' || line.startsWith('%')) return out;
      const tag = moves.length === 0 ? /^\[([A-Za-z0-9_]+)\s+"(.*)"\]\s*$/.exec(line) : null;
      if (tag) tags[/** @type {string} */ (tag[1])] = /** @type {string} */ (tag[2]);
      else moves.push(line);
      any = true;
      return out;
    },
    flush: take,
  };
}

/**
 * The `[%eval …]` of a comment body as a White-POV score: `0.35` → `{cp: 35}`, `#-3` →
 * `{mate: -3}`; undefined without (or with a malformed) eval.
 * @param {string} body
 * @returns {{ cp: number } | { mate: number } | undefined}
 */
export function parseEval(body) {
  const m = /\[%eval\s+([^\]\s,]+)/.exec(body);
  if (!m) return undefined;
  const v = /** @type {string} */ (m[1]);
  if (v.startsWith('#')) {
    if (!/^#-?\d+$/.test(v)) return undefined;
    return { mate: Number(v.slice(1)) };
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(v)) return undefined;
  return { cp: Math.round(Number(v) * 100) };
}

/**
 * SAN moves of a movetext and the eval annotated after each (index-aligned; undefined when the
 * move has none). Move numbers, NAGs, `!?` suffixes, results and variations are skipped.
 * @param {string} text
 */
export function parseMovetext(text) {
  /** @type {string[]} */
  const sans = [];
  /** @type {({ cp: number } | { mate: number } | undefined)[]} */
  const evals = [];
  const n = text.length;
  let depth = 0;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '{') {
      const end = text.indexOf('}', i + 1);
      const body = text.slice(i + 1, end < 0 ? n : end);
      if (depth === 0 && sans.length > 0) {
        const e = parseEval(body);
        if (e) evals[sans.length - 1] = e;
      }
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === ';') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !' \t\n\r{}();'.includes(/** @type {string} */ (text[j]))) j++;
    const tok = text.slice(i, j);
    i = j;
    if (depth > 0) continue;
    if (/^\$\d+$/.test(tok) || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
    const san = tok.replace(/^\d+\.+/, '').replace(/[?!]+$/, '');
    if (!san) continue;
    sans.push(san);
    evals.push(undefined);
  }
  return { sans, evals };
}

/**
 * Header-level filter (cheap; runs before any replay). Returns the reason a game is skipped, or
 * the fields the analysis needs.
 * @param {{ tags: Record<string, string>, movetext: string }} g
 * @returns {{ ok: false, reason: string } | { ok: true, game: import('./calibrate-elo.d.mts').EligibleGame }}
 */
export function eligibleGame(g) {
  const t = g.tags;
  const no = (/** @type {string} */ reason) => ({ ok: /** @type {const} */ (false), reason });
  // Most games of a dump are not evaluated: test that first.
  if (!g.movetext.includes('[%eval')) return no('no-eval');
  if (/^casual\b/i.test(t.Event ?? '')) return no('casual');
  if (t.Variant !== undefined && t.Variant !== 'Standard') return no('variant');
  if (t.FEN !== undefined || t.SetUp === '1') return no('setup');
  if (!/^\d+$/.test(t.WhiteElo ?? '') || !/^\d+$/.test(t.BlackElo ?? '')) return no('no-rating');
  if (!/^[+-]?\d+$/.test(t.WhiteRatingDiff ?? '') || !/^[+-]?\d+$/.test(t.BlackRatingDiff ?? '')) {
    return no('provisional');
  }
  if (t.Termination === 'Abandoned' || t.Termination === 'Rules infraction') {
    return no('termination');
  }
  return {
    ok: true,
    game: {
      white: Number(t.WhiteElo),
      black: Number(t.BlackElo),
      ...(t.TimeControl !== undefined ? { timeControl: t.TimeControl } : {}),
      movetext: g.movetext,
    },
  };
}

// --- book ----------------------------------------------------------------------------------------

/**
 * The book check of the app over the rows of `openings.json` (`[eco, name, epd, moves]`):
 * `inBook(prefix)` ⇔ `Book.inBook` (some named line starts with the SAN prefix; the empty prefix is
 * in book), `lineAt(epd)` ⇔ the position lookup `findOpening([epd])` (first row per EPD wins) with
 * a non-empty line.
 * @param {readonly (readonly string[])[]} rows
 * @returns {import('./calibrate-elo.d.mts').BookIndex}
 */
export function buildBookIndex(rows) {
  const prefixes = new Set(['']);
  /** @type {Map<string, string[]>} */
  const byEpd = new Map();
  for (const row of rows) {
    const epd = row[2] ?? '';
    const moves = (row[3] ?? '').split(' ').filter(Boolean);
    if (!byEpd.has(epd)) byEpd.set(epd, moves);
    let key = '';
    for (const san of moves) {
      key = key ? `${key} ${san}` : san;
      prefixes.add(key);
    }
  }
  return {
    inBook: (prefix) => prefixes.has(prefix.join(' ')),
    lineAt: (epd) => {
      const line = byEpd.get(epd);
      return line && line.length > 0 ? line : undefined;
    },
  };
}

/** FEN without the move counters (`openings/index.ts` `toEpd`). */
export const toEpd = (/** @type {string} */ fen) => fen.split(' ').slice(0, 4).join(' ');

/**
 * Incremental book walk, the rule of `computeOpeningFocus` (`review/openingFocus.ts`): a move is
 * in book when the book line so far plus the move is a named-line prefix, or when it reaches a
 * named position (a transposition; the walk continues from that variation's line). The first
 * move that is neither ends the book for good. `epd()` is called only on a prefix miss.
 * @param {import('./calibrate-elo.d.mts').BookIndex} book
 */
export function bookWalker(book) {
  /** @type {readonly string[]} */
  let prefix = [];
  let open = true;
  let lastBookPly = 0;
  let ply = 0;
  return {
    /** @param {string} san @param {() => string} epd */
    step(san, epd) {
      ply++;
      if (!open) return;
      const next = [...prefix, san];
      if (book.inBook(next)) {
        prefix = next;
        lastBookPly = ply;
        return;
      }
      const line = book.lineAt(epd());
      if (line) {
        prefix = line;
        lastBookPly = ply;
        return;
      }
      open = false;
    },
    get lastBookPly() {
      return lastBookPly;
    },
  };
}

/** Last ply still in book for a SAN game from the standard start (`epds[i]` after ply i). */
export function lastBookPlyOf(
  /** @type {import('./calibrate-elo.d.mts').BookIndex} */ book,
  /** @type {readonly string[]} */ sans,
  /** @type {readonly string[]} */ epds,
) {
  const w = bookWalker(book);
  sans.forEach((san, i) => w.step(san, () => /** @type {string} */ (epds[i + 1])));
  return w.lastBookPly;
}

// --- per game ------------------------------------------------------------------------------------

/** @typedef {typeof import('@daisychess/engine-core')} EngineCore */

/** The built engine-core (`pnpm --filter @daisychess/engine-core build`). */
export async function loadEngineCore() {
  try {
    return /** @type {EngineCore} */ (await import('@daisychess/engine-core'));
  } catch (e) {
    throw new Error(
      `cannot load @daisychess/engine-core (run \`pnpm --filter @daisychess/engine-core build\` first): ${/** @type {Error} */ (e).message}`,
    );
  }
}

const moverOf = (/** @type {number} */ ply) => (ply % 2 === 1 ? 'white' : 'black');

/**
 * Number of legal moves. chess.js's public `moves()` builds a SAN string (with a check test) per
 * move, ≈ 3× the cost of its internal generator; the internal one is used when present (same
 * count), the public one otherwise (a chess.js upgrade that renames it only costs speed).
 * @param {Chess} chess
 */
function legalMoveCount(chess) {
  const internal = /** @type {{ _moves?: (o: { legal: boolean }) => unknown[] }} */ (
    /** @type {unknown} */ (chess)
  )._moves;
  return typeof internal === 'function'
    ? internal.call(chess, { legal: true }).length
    : chess.moves().length;
}

/**
 * One eligible game → a sample per side whose selection has ≥ 10 positions, or the reason it
 * gives none. The review is the app's (`reviewGame` with lichess's evals, the start position at
 * {@link START_EVAL}; a final checkmate without an eval is `{mate: 0}`, a final stalemate or
 * other draw `{cp: 0}`); legal moves are counted where the selection needs them.
 * @param {EngineCore} E
 * @param {import('./calibrate-elo.d.mts').BookIndex} book
 * @param {import('./calibrate-elo.d.mts').EligibleGame} game
 * @returns {{ samples: import('./calibrate-elo.d.mts').EloSamplePoint[], reason?: string }}
 */
export function analyzeGame(E, book, game) {
  const { sans, evals } = parseMovetext(game.movetext);
  if (sans.length === 0) return { samples: [], reason: 'no-moves' };
  const chess = new Chess();
  const walk = bookWalker(book);
  const fens = [chess.fen()];
  /** @type {{ uci: string, san: string, legalMoves?: number }[]} */
  const moves = [];
  /** @type {({ cp: number } | { mate: number })[]} */
  const scores = [START_EVAL];
  const { min, max } = E.ELO_UNDECIDED_RANGE;
  for (let i = 0; i < sans.length; i++) {
    const ply = i + 1;
    const before = /** @type {{ cp: number } | { mate: number }} */ (scores[i]);
    // The selection needs the legal-move count only in undecided positions (the mover's win
    // probability before the move, as `reviewGame` computes it).
    const white = E.scoreToWinProbability(before);
    const wp = moverOf(ply) === 'white' ? white : 100 - white;
    const legalMoves = wp >= min && wp <= max ? legalMoveCount(chess) : undefined;
    let m;
    try {
      m = chess.move(/** @type {string} */ (sans[i]));
    } catch {
      return { samples: [], reason: 'illegal' };
    }
    const fen = chess.fen();
    fens.push(fen);
    walk.step(m.san, () => toEpd(fen));
    moves.push({
      uci: m.from + m.to + (m.promotion ?? ''),
      san: m.san,
      ...(legalMoves !== undefined ? { legalMoves } : {}),
    });
    let after = evals[i];
    if (after === undefined && ply === sans.length) {
      if (chess.isCheckmate()) after = { mate: 0 };
      else if (chess.isDraw()) after = { cp: 0 };
    }
    if (after === undefined) return { samples: [], reason: 'missing-eval' };
    scores.push(after);
  }
  const summary = E.reviewGame({
    positions: fens.map((fen, k) => ({
      fen,
      eval: /** @type {{ cp: number } | { mate: number }} */ (scores[k]),
    })),
    moves,
  });
  const reviewed = summary.moves.map((r, k) => {
    const n = moves[k]?.legalMoves;
    return n !== undefined ? { ...r, legalMoves: n } : r;
  });
  const lastBookPly = walk.lastBookPly;
  const speed = E.speedClass(game.timeControl);
  /** @type {import('./calibrate-elo.d.mts').EloSamplePoint[]} */
  const samples = [];
  for (const side of /** @type {const} */ (['white', 'black'])) {
    const sel = E.selectEloPlies(reviewed, side, lastBookPly);
    if (sel.length === 0) continue;
    const meanLoss = sel.reduce((s, r) => s + r.winProbLoss, 0) / sel.length;
    samples.push({
      speed,
      rating: side === 'white' ? game.white : game.black,
      meanLoss,
      positions: sel.length,
    });
  }
  return samples.length > 0 ? { samples } : { samples, reason: 'too-few-positions' };
}

/**
 * A batch of eligible games → flat samples `[speedIndex, rating, meanLoss, positions, …]`
 * (speedIndex into `SPEED_CLASSES`), counts and reasons. A game that throws counts as `error`.
 * @param {EngineCore} E
 * @param {import('./calibrate-elo.d.mts').BookIndex} book
 * @param {import('./calibrate-elo.d.mts').EligibleGame[]} games
 * @returns {import('./calibrate-elo.d.mts').BatchResult}
 */
export function analyzeBatch(E, book, games) {
  /** @type {number[]} */
  const samples = [];
  /** @type {Record<string, number>} */
  const rejects = {};
  let used = 0;
  for (const g of games) {
    let r;
    try {
      r = analyzeGame(E, book, g);
    } catch {
      r = { samples: [], reason: 'error' };
    }
    if (r.reason) rejects[r.reason] = (rejects[r.reason] ?? 0) + 1;
    if (r.samples.length > 0) used++;
    for (const s of r.samples) {
      samples.push(E.SPEED_CLASSES.indexOf(s.speed), s.rating, s.meanLoss, s.positions);
    }
  }
  return { samples, rejects, games: games.length, used };
}

// --- fit -----------------------------------------------------------------------------------------

/**
 * Isotonic regression of y on x, non-increasing (more loss → lower rating), by
 * pool-adjacent-violators. Points with equal x are pooled first, so block centroids are strictly
 * ascending in x. Returns the blocks `{x (weighted mean), y (fitted value), w}` in x order.
 * @param {readonly (readonly [number, number])[]} points `[x, y]`
 */
export function isotonicDecreasing(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /** @type {{ sx: number, sy: number, w: number }[]} */
  const stack = [];
  /** @type {{ x: number, sx: number, sy: number, w: number } | undefined} */
  let tie;
  const pushBlock = (/** @type {{ sx: number, sy: number, w: number }} */ b) => {
    stack.push({ sx: b.sx, sy: b.sy, w: b.w });
    // Violation of non-increasing: the previous block's mean is below the new one's.
    while (stack.length > 1) {
      const last = /** @type {{ sx: number, sy: number, w: number }} */ (stack[stack.length - 1]);
      const prev = /** @type {{ sx: number, sy: number, w: number }} */ (stack[stack.length - 2]);
      if (prev.sy / prev.w >= last.sy / last.w) break;
      stack.pop();
      prev.sx += last.sx;
      prev.sy += last.sy;
      prev.w += last.w;
    }
  };
  for (const [x, y] of sorted) {
    if (tie && tie.x === x) {
      tie.sx += x;
      tie.sy += y;
      tie.w++;
      continue;
    }
    if (tie) pushBlock(tie);
    tie = { x, sx: x, sy: y, w: 1 };
  }
  if (tie) pushBlock(tie);
  return stack.map((b) => ({ x: b.sx / b.w, y: b.sy / b.w, w: b.w }));
}

/**
 * At most `maxKnots` knots from the isotonic blocks: consecutive blocks are grouped by
 * cumulative weight into equal-weight groups, each group becomes its weighted centroid. Weighted
 * means of consecutive monotone blocks stay monotone, and the groups' x stay strictly ascending.
 * @param {readonly { x: number, y: number, w: number }[]} blocks
 * @param {number} maxKnots
 */
export function decimate(blocks, maxKnots) {
  if (blocks.length <= maxKnots) return blocks.map((b) => ({ ...b }));
  const total = blocks.reduce((s, b) => s + b.w, 0);
  /** @type {{ sx: number, sy: number, w: number }[]} */
  const groups = [];
  let seen = 0;
  let current = -1;
  for (const b of blocks) {
    // The group of a block is fixed by the weight before its centre.
    const g = Math.min(maxKnots - 1, Math.floor(((seen + b.w / 2) / total) * maxKnots));
    if (g !== current) {
      groups.push({ sx: 0, sy: 0, w: 0 });
      current = g;
    }
    const last = /** @type {{ sx: number, sy: number, w: number }} */ (groups[groups.length - 1]);
    last.sx += b.x * b.w;
    last.sy += b.y * b.w;
    last.w += b.w;
    seen += b.w;
  }
  return groups.map((g) => ({ x: g.sx / g.w, y: g.sy / g.w, w: g.w }));
}

/** Linear interpolation over `[x, y]` knots, flat beyond the ends (as `fallbackElo`). */
export function interpolate(
  /** @type {readonly (readonly [number, number])[]} */ knots,
  /** @type {number} */ x,
) {
  const first = /** @type {readonly [number, number]} */ (knots[0]);
  const last = /** @type {readonly [number, number]} */ (knots[knots.length - 1]);
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  let k = 1;
  while (/** @type {readonly [number, number]} */ (knots[k])[0] < x) k++;
  const [x0, y0] = /** @type {readonly [number, number]} */ (knots[k - 1]);
  const [x1, y1] = /** @type {readonly [number, number]} */ (knots[k]);
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/**
 * One speed class's curve: isotonic fit, decimated, knots rounded (loss to 0.01, rating to 1;
 * knots that collide after rounding are merged by weight), residual sd of the interpolated
 * curve over all points (0.1). Undefined when fewer than two distinct knots remain.
 * @param {readonly (readonly [number, number])[]} points `[meanLoss, rating]`
 * @param {number} maxKnots
 * @returns {{ knots: [number, number][], residualSd: number } | undefined}
 */
export function fitCurve(points, maxKnots = DEFAULT_MAX_KNOTS) {
  if (points.length === 0) return undefined;
  const groups = decimate(isotonicDecreasing(points), maxKnots);
  /** @type {{ x: number, sy: number, w: number }[]} */
  const merged = [];
  for (const g of groups) {
    const x = Math.round(g.x * 100) / 100;
    const last = merged[merged.length - 1];
    if (last && last.x === x) {
      last.sy += g.y * g.w;
      last.w += g.w;
    } else merged.push({ x, sy: g.y * g.w, w: g.w });
  }
  if (merged.length < 2) return undefined;
  /** @type {[number, number][]} */
  const knots = merged.map((m) => [m.x, Math.round(m.sy / m.w)]);
  let ss = 0;
  for (const [x, y] of points) ss += (y - interpolate(knots, x)) ** 2;
  return { knots, residualSd: Math.round(Math.sqrt(ss / points.length) * 10) / 10 };
}

// --- worker pool ---------------------------------------------------------------------------------

/**
 * `jobs` worker threads, one batch each at a time. `submit` resolves once a worker took the batch
 * (so the reader pauses while all are busy: bounded memory); a worker error or exit fails every
 * pending and later call.
 */
class WorkerPool {
  /**
   * @param {number} jobs
   * @param {string} openings
   * @param {(r: import('./calibrate-elo.d.mts').BatchResult) => void} onResult
   */
  constructor(jobs, openings, onResult) {
    /** @type {Worker[]} */
    this.workers = [];
    /** @type {Worker[]} */
    this.idle = [];
    /** @type {(() => void)[]} */
    this.waiters = [];
    this.inflight = 0;
    /** @type {Error | null} */
    this.error = null;
    this.closing = false;
    for (let k = 0; k < jobs; k++) {
      const w = new Worker(fileURLToPath(import.meta.url), {
        workerData: { kind: 'calibrate-elo', openings },
      });
      w.on('message', (/** @type {import('./calibrate-elo.d.mts').BatchResult} */ r) => {
        this.inflight--;
        try {
          onResult(r);
        } catch (e) {
          this.fail(/** @type {Error} */ (e));
        }
        this.idle.push(w);
        this.wake();
      });
      w.on('error', (e) => this.fail(e));
      w.on('exit', (code) => {
        if (!this.closing) this.fail(new Error(`calibration worker exited with ${code}`));
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  wake() {
    const w = this.waiters.splice(0);
    for (const r of w) r();
  }

  /** @param {Error} e */
  fail(e) {
    this.error ??= e;
    this.wake();
  }

  /** @param {import('./calibrate-elo.d.mts').EligibleGame[]} batch */
  async submit(batch) {
    while (!this.error && this.idle.length === 0) {
      await new Promise((r) => this.waiters.push(/** @type {() => void} */ (r)));
    }
    if (this.error) throw this.error;
    const w = /** @type {Worker} */ (this.idle.pop());
    this.inflight++;
    w.postMessage(batch);
  }

  async drain() {
    while (!this.error && this.inflight > 0) {
      await new Promise((r) => this.waiters.push(/** @type {() => void} */ (r)));
    }
    if (this.error) throw this.error;
  }

  async close() {
    this.closing = true;
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

// --- the run -------------------------------------------------------------------------------------

/** Writes through a temp file and a rename (readers never see a half-written file). */
function writeAtomic(/** @type {string} */ path, /** @type {string} */ content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Pretty JSON with every knot on one line (small, reviewable diffs). */
export function formatTable(/** @type {unknown} */ table) {
  return `${JSON.stringify(table, null, 2).replace(
    /\[\n\s+(-?[\d.]+),\n\s+(-?[\d.]+)\n\s+\]/g,
    '[$1, $2]',
  )}\n`;
}

const add = (
  /** @type {Record<string, number>} */ into,
  /** @type {Record<string, number>} */ c,
) => {
  for (const [k, v] of Object.entries(c)) into[k] = (into[k] ?? 0) + v;
};

/**
 * The whole calibration. Returns the summary and the table; writes the table and SOURCE.md next
 * to it unless `dryRun`. Throws on any failed check (digest, decoding, too few samples, schema).
 * @param {import('./calibrate-elo.d.mts').CalibrateOptions} o
 * @param {(line: string) => void} [log]
 * @returns {Promise<import('./calibrate-elo.d.mts').CalibrateSummary>}
 */
export async function calibrateElo(o, log = console.log) {
  const E = await loadEngineCore();
  const t0 = Date.now();
  const input = resolve(o.input);
  const size = statSync(input).size;
  const limitBytes = o.sample ? Math.min(o.sample, size) : size;
  const month = o.month ?? monthFromName(input);
  if (!month) throw new Error('--month is required (the input name has no _YYYY-MM)');
  const minSamples = o.minSamples ?? DEFAULT_MIN_SAMPLES;
  const maxKnots = o.maxKnots ?? DEFAULT_MAX_KNOTS;
  const openings = resolve(o.openings ?? DEFAULT_OPENINGS);
  const jobs = o.jobs ?? defaultJobs();

  const sha256 = await hashFile(input, limitBytes);
  if (o.sha256 && o.sha256 !== sha256) {
    throw new Error(`sha256 mismatch: ${input} is ${sha256}, expected ${o.sha256}`);
  }
  log(
    `input ${input}: ${limitBytes} bytes${limitBytes < size ? ` (sample of ${size})` : ''}, sha256 ${sha256}`,
  );

  /** @type {Record<string, number>} */
  const rejects = {};
  let gamesRead = 0;
  let analyzed = 0;
  let used = 0;
  /** @type {number[]} */
  const flat = [];
  const onResult = (/** @type {import('./calibrate-elo.d.mts').BatchResult} */ r) => {
    add(rejects, r.rejects);
    used += r.used;
    for (const v of r.samples) flat.push(v);
  };

  const book = buildBookIndex(JSON.parse(readFileSync(openings, 'utf8')));
  const pool = jobs > 1 ? new WorkerPool(jobs, openings, onResult) : null;
  /** @param {import('./calibrate-elo.d.mts').EligibleGame[]} batch */
  const run = async (batch) => {
    if (pool) await pool.submit(batch);
    else onResult(analyzeBatch(E, book, batch));
  };

  const info = { bytes: 0, partial: false };
  let lastLog = Date.now();
  try {
    const split = createGameSplitter();
    /** @type {import('./calibrate-elo.d.mts').EligibleGame[]} */
    let batch = [];
    const take = async (
      /** @type {{ tags: Record<string, string>, movetext: string } | undefined} */ g,
    ) => {
      if (!g) return;
      gamesRead++;
      const e = eligibleGame(g);
      if (!e.ok) {
        rejects[e.reason] = (rejects[e.reason] ?? 0) + 1;
        return;
      }
      analyzed++;
      batch.push(e.game);
      if (batch.length >= BATCH_GAMES) {
        const b = batch;
        batch = [];
        await run(b);
      }
    };
    const limitReached = () => o.limit !== undefined && analyzed >= o.limit;
    for await (const line of readLines(input, o, info)) {
      await take(split.push(line));
      if (limitReached()) break;
      if (Date.now() - lastLog > 30_000) {
        lastLog = Date.now();
        log(`… ${gamesRead} games read, ${analyzed} evaluated and eligible, ${secs(t0)}`);
      }
    }
    // The last game of a partial read may be cut: dropped. With --limit the loop stopped early.
    if (!info.partial && !limitReached()) await take(split.flush());
    if (batch.length > 0) await run(batch);
    if (pool) await pool.drain();
  } finally {
    if (pool) await pool.close();
  }
  log(
    `read ${gamesRead} games, ${analyzed} evaluated and eligible, ${used} gave samples, ${secs(t0)}`,
  );

  /** @type {Record<string, [number, number][]>} */
  const bySpeed = {};
  /** @type {[number, number][]} */
  const pooled = [];
  for (let i = 0; i < flat.length; i += 4) {
    const speed = E.SPEED_CLASSES[/** @type {number} */ (flat[i])] ?? 'unknown';
    /** @type {[number, number]} */
    const p = [/** @type {number} */ (flat[i + 2]), /** @type {number} */ (flat[i + 1])];
    (bySpeed[speed] ??= []).push(p);
    pooled.push(p);
  }
  if (pooled.length < minSamples) {
    throw new Error(`only ${pooled.length} samples in total, at least ${minSamples} needed`);
  }
  /** @type {Record<string, { knots: [number, number][], residualSd: number }>} */
  const speeds = {};
  /** @type {Record<string, number>} */
  const samples = { unknown: pooled.length };
  for (const speed of SPEED_ORDER) {
    const pts = bySpeed[speed] ?? [];
    samples[speed] = pts.length;
    if (pts.length < minSamples) continue;
    const c = fitCurve(pts, maxKnots);
    if (c) speeds[speed] = c;
  }
  const all = fitCurve(pooled, maxKnots);
  if (!all) throw new Error('the pooled samples give fewer than two knots');
  speeds.unknown = all;
  const table = E.EloCalibrationSchema.parse({
    version: 1,
    source: { month, games: used, sha256 },
    speeds,
  });

  const summary = {
    sha256,
    bytes: limitBytes,
    partial: info.partial,
    month,
    gamesRead,
    analyzed,
    used,
    rejects,
    samples,
    table,
    seconds: 0,
    maxRssMb: 0,
  };
  if (!o.dryRun && o.out) {
    const out = resolve(o.out);
    writeAtomic(out, formatTable(table));
    writeAtomic(join(dirname(out), 'SOURCE.md'), sourceMd(o, summary));
    log(`wrote ${out} and SOURCE.md`);
  }
  summary.seconds = Math.round((Date.now() - t0) / 1000);
  summary.maxRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
  printSummary(E, summary, log);
  return summary;
}

const secs = (/** @type {number} */ t0) => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

/**
 * @param {EngineCore} E
 * @param {import('./calibrate-elo.d.mts').CalibrateSummary} s
 * @param {(line: string) => void} log
 */
function printSummary(E, s, log) {
  log('');
  log(`games read ${s.gamesRead}, evaluated and eligible ${s.analyzed}, used ${s.used}`);
  log(
    `skipped: ${
      Object.entries(s.rejects)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }`,
  );
  const probes = [1, 2, 4, 6, 8, 12, 16];
  log(`speed       samples knots  sd    ${probes.map((p) => `@${p}%`.padStart(6)).join('')}`);
  for (const speed of [...SPEED_ORDER, 'unknown']) {
    const c =
      /** @type {Record<string, import('@daisychess/engine-core').EloCurve | undefined>} */ (
        s.table.speeds
      )[speed];
    const n = String(s.samples[speed] ?? 0).padStart(7);
    if (!c) {
      log(`${speed.padEnd(11)} ${n}     -     -  (too few samples: falls back to unknown)`);
      continue;
    }
    const at = probes
      .map((p) =>
        String(
          E.fallbackElo(
            p,
            /** @type {import('@daisychess/engine-core').SpeedClass} */ (speed),
            s.table,
          ).rating,
        ).padStart(6),
      )
      .join('');
    log(
      `${speed.padEnd(11)} ${n} ${String(c.knots.length).padStart(5)} ${String(Math.round(c.residualSd)).padStart(5)}  ${at}`,
    );
  }
  log(`peak RSS ${s.maxRssMb} MB, ${s.seconds} s`);
}

/**
 * SOURCE.md next to the table.
 * @param {import('./calibrate-elo.d.mts').CalibrateOptions} o
 * @param {import('./calibrate-elo.d.mts').CalibrateSummary} s
 */
function sourceMd(o, s) {
  const provisional =
    s.month === 'provisional'
      ? `
**Provisional table.** \`source.month\` is \`provisional\`, so the app labels the estimate a
rough one. Replace it with a calibrated run on a full monthly sample (\`deploy/calibrate-elo.sh\`,
deploy/README.md "Elo calibration").
`
      : '';
  const sample = s.partial
    ? `
**Partial read**: only the first ${s.bytes} bytes of the dump were read (a ranged download,
\`--sample\`); the sha256 below is of those bytes${o.dumpSha256 ? ', the whole dump is listed by lichess as noted' : ''}.
`
    : '';
  const rows = [
    [
      'Source',
      o.source
        ? `<${o.source}> (lichess.org open database, CC0-1.0)`
        : `\`${basename(o.input)}\` (lichess.org open database, CC0-1.0)`,
    ],
    ['Month', s.month],
    [s.partial ? 'sha256 (bytes read)' : 'sha256', `\`${s.sha256}\``],
    ...(o.dumpSha256 ? [['sha256 (whole dump, lichess sha256sums)', `\`${o.dumpSha256}\``]] : []),
    ['Bytes read', String(s.bytes)],
    ['Built', o.builtAt ?? new Date().toISOString()],
    ['Games read', String(s.gamesRead)],
    ['Evaluated and eligible', String(s.analyzed)],
    ['Games with a sample', String(s.used)],
    [
      'Samples (sides)',
      [...SPEED_ORDER, 'unknown']
        .map(
          (k) =>
            `${k} ${s.samples[k] ?? 0}${k !== 'unknown' && !s.table.speeds[/** @type {'bullet'} */ (k)] ? ' (omitted)' : ''}`,
        )
        .join(', '),
    ],
  ];
  return `# Elo fallback calibration: source

Generated by \`apps/web/scripts/calibrate-elo.mjs\` (ADR-024 §5); do not edit \`eloCalibration.json\` by
hand. Regenerate with \`deploy/calibrate-elo.sh\` (deploy/README.md "Elo calibration").
${provisional}${sample}
| | |
| --- | --- |
${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

Method: lichess games that carry \`[%eval]\` annotations (lichess's own server analysis; no engine
ran here), rated standard games with both ratings established (RatingDiff present). Each side's
mean win-probability loss over the positions the live estimate scores (\`selectEloPlies\`: after
the book, not forced, mover win probability 10–90 %, ≥ 10 positions) is paired with the player's
lichess rating; per speed class (lichess rule on \`TimeControl\`) an isotonic regression of rating
on mean loss (pool-adjacent-violators) is decimated to ≤ ${o.maxKnots ?? DEFAULT_MAX_KNOTS} knots of equal weight; \`residualSd\`
is the residual standard deviation of the interpolated curve. \`unknown\` pools every sample.
Classes with fewer than ${o.minSamples ?? DEFAULT_MIN_SAMPLES} samples are omitted (the app uses \`unknown\`).

Licence: the lichess database is released under CC0 1.0 (public domain dedication),
<https://database.lichess.org/>.
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
    await calibrateElo(opts);
  } catch (e) {
    console.error(`calibrate-elo: ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
}

if (!isMainThread && workerData?.kind === 'calibrate-elo') {
  const E = await loadEngineCore();
  const book = buildBookIndex(JSON.parse(readFileSync(workerData.openings, 'utf8')));
  parentPort?.on('message', (/** @type {import('./calibrate-elo.d.mts').EligibleGame[]} */ games) =>
    parentPort?.postMessage(analyzeBatch(E, book, games)),
  );
} else if (
  isMainThread &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main();
}
