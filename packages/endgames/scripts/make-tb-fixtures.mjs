#!/usr/bin/env node
// Reference fixtures for the Syzygy reader (M32-2, ADR-025 §2): random legal positions per
// material with the lichess tablebase API's answer (category and DTZ of the position and of
// every legal move), written to test/fixtures/tb-reference.json. Run once by hand on a host with
// network access; never in CI (the tests only read the committed JSON).
//
//   node packages/endgames/scripts/make-tb-fixtures.mjs --from-api
//        [--core 300] [--rook 200] [--no-extras] [--seed 20261106] [--spacing 400] [--out <file>]
//
// Besides the random positions it queries EXTRA_POSITIONS (50-move counter, mate, stalemate,
// promotions) unless --no-extras.
// The positions are deterministic for a seed (mulberry32). Requests are sequential with
// --spacing ms between them; a 429 waits for Retry-After (default 60 s) and retries.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = join(HERE, '..', 'test', 'fixtures', 'tb-reference.json');
export const API = 'https://tablebase.lichess.ovh/standard';
export const CORE_MATERIALS = ['KQvK', 'KRvK', 'KPvK', 'KBBvK', 'KBNvK', 'KQvKP'];
export const ROOK_MATERIALS = ['KRPvKR'];

/**
 * Hand-picked positions queried in addition to the random ones: the 50-move counter (KBNvK
 * with DTZ -54 at different halfmove clocks, K+P vs K at clock 99), mate and stalemate,
 * promotions into KQvKQ … KQvKN and a capture into KQvK.
 */
export const EXTRA_POSITIONS = [
  ['KBNvK', '8/2K5/4B3/3N4/8/8/4k3/8 b - - 0 1'],
  ['KBNvK', '8/2K5/4B3/3N4/8/8/4k3/8 b - - 46 80'],
  ['KBNvK', '8/2K5/4B3/3N4/8/8/4k3/8 b - - 50 80'],
  ['KBNvK', '8/2K5/4B3/3N4/8/8/4k3/8 b - - 99 80'],
  ['KPvK', '8/8/8/4k3/8/8/4P3/4K3 w - - 99 120'],
  ['KQvK', 'k7/1Q6/1K6/8/8/8/8/8 b - - 0 1'],
  ['KQvK', 'k7/2Q5/1K6/8/8/8/8/8 b - - 0 1'],
  ['KQvK', 'k7/8/1K6/8/8/8/8/2Q5 w - - 0 1'],
  ['KQvKP', 'K7/8/8/8/8/8/1pk5/7Q b - - 0 1'],
  ['KQvKP', '8/8/8/8/8/1Q6/2p5/K1k5 w - - 0 1'],
  ['KQvKP', '8/8/8/8/8/1Q6/2p5/K1k5 w - - 30 60'],
  ['KRPvKR', '1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1'],
];

/** Deterministic PRNG in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILES = 'abcdefgh';
const squareName = (s) => FILES[s & 7] + String((s >> 3) + 1);

/**
 * One random legal position of `material` (`KRPvKR`: White K R P, Black K R) without castling
 * rights or en passant, halfmove clock 0: distinct squares, no pawn on the first/last rank,
 * the side not to move not in check. Returns a FEN.
 */
export function randomPosition(material, rng) {
  const [white, black] = material.split('v');
  for (;;) {
    const board = new Array(64).fill('');
    const used = new Set();
    let ok = true;
    const place = (letter) => {
      for (let tries = 0; tries < 100; tries++) {
        const s = Math.floor(rng() * 64);
        const r = s >> 3;
        if (used.has(s)) continue;
        if (letter.toLowerCase() === 'p' && (r === 0 || r === 7)) continue;
        used.add(s);
        board[s] = letter;
        return;
      }
      ok = false;
    };
    for (const c of white) place(c.toUpperCase());
    for (const c of black) place(c.toLowerCase());
    if (!ok) continue;
    const turn = rng() < 0.5 ? 'w' : 'b';
    const ranks = [];
    for (let r = 7; r >= 0; r--) {
      let row = '';
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = board[r * 8 + f];
        if (!p) {
          empty++;
          continue;
        }
        if (empty) row += String(empty);
        empty = 0;
        row += p;
      }
      if (empty) row += String(empty);
      ranks.push(row);
    }
    const fen = `${ranks.join('/')} ${turn} - - 0 1`;
    let chess;
    try {
      chess = new Chess(fen);
    } catch {
      continue;
    }
    const them = turn === 'w' ? 'b' : 'w';
    const theirKing = board.findIndex((p) => p === (them === 'w' ? 'K' : 'k'));
    if (chess.isAttacked(squareName(theirKing), turn)) continue;
    return fen;
  }
}

/** `n` distinct random positions of `material`. */
export function randomPositions(material, n, rng) {
  const out = new Set();
  let guard = 0;
  while (out.size < n && guard++ < n * 100) out.add(randomPosition(material, rng));
  return [...out];
}

const dtzText = (precise, rounded) =>
  precise !== null && precise !== undefined
    ? String(precise)
    : rounded !== null && rounded !== undefined
      ? `~${rounded}`
      : '-';

/**
 * Compact fixture entry of one API answer: `dtz` as text (`15`, `~16` when lichess marks it
 * rounded, `-` when absent) and each move as `"<uci> <category> <dtz>"`.
 */
export function compactAnswer(fen, material, json) {
  return {
    fen,
    material,
    category: json.category,
    dtz: dtzText(json.precise_dtz, json.dtz),
    checkmate: Boolean(json.checkmate),
    stalemate: Boolean(json.stalemate),
    moves: json.moves.map((m) => `${m.uci} ${m.category} ${dtzText(m.precise_dtz, m.dtz)}`),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function query(fen, spacing) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = `${API}?fen=${encodeURIComponent(fen)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'DaisyChess tablebase fixtures (one-off; daisychess.org)' },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? '60');
      console.error(`429, waiting ${wait}s`);
      await sleep((Number.isFinite(wait) ? wait : 60) * 1000);
      continue;
    }
    if (!res.ok) {
      console.error(`HTTP ${res.status} for ${fen}, retrying`);
      await sleep(5000 + spacing);
      continue;
    }
    return res.json();
  }
  throw new Error(`giving up on ${fen}`);
}

export function parseArgs(argv) {
  const opts = {
    fromApi: false,
    core: 300,
    rook: 200,
    extras: true,
    seed: 20261106,
    spacing: 400,
    out: DEFAULT_OUT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--from-api') opts.fromApi = true;
    else if (a === '--core') opts.core = Number(next());
    else if (a === '--rook') opts.rook = Number(next());
    else if (a === '--no-extras') opts.extras = false;
    else if (a === '--seed') opts.seed = Number(next());
    else if (a === '--spacing') opts.spacing = Number(next());
    else if (a === '--out') opts.out = next();
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.fromApi) {
    console.error('refusing to run without --from-api (this queries tablebase.lichess.ovh)');
    process.exit(2);
  }
  const rng = mulberry32(opts.seed);
  const jobs = [];
  for (const m of CORE_MATERIALS)
    for (const fen of randomPositions(m, opts.core, rng)) jobs.push([m, fen]);
  for (const m of ROOK_MATERIALS)
    for (const fen of randomPositions(m, opts.rook, rng)) jobs.push([m, fen]);
  if (opts.extras) jobs.push(...EXTRA_POSITIONS);
  const positions = [];
  let i = 0;
  for (const [material, fen] of jobs) {
    const json = await query(fen, opts.spacing);
    positions.push(compactAnswer(fen, material, json));
    if (++i % 50 === 0) console.error(`${i}/${jobs.length}`);
    await sleep(opts.spacing);
  }
  const out = {
    format: 1,
    source: `${API} (lichess-org/lila-tablebase), fetched ${new Date().toISOString().slice(0, 10)}`,
    seed: opts.seed,
    positions,
  };
  writeFileSync(opts.out, JSON.stringify(out, null, 1) + '\n');
  console.error(`wrote ${positions.length} positions to ${opts.out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
