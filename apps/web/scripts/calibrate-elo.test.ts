// @vitest-environment node
// Elo calibration (M31-8, ADR-024 §5): calibrate-elo.mjs end to end on the committed 211-game
// lichess fixture (200 evaluated), its parts (PGN/eval parsing, filters, the book check against the
// app's `Book` and `computeOpeningFocus`, PAVA, decimation), the stream reader (zstd via zlib and
// the CLI, truncated ranged samples, --limit), the worker-thread path, the committed table, and
// deploy/calibrate-elo.sh with file:// URLs. Needs the built engine-core for the worker threads
// and the CLI (`pnpm -r --filter "./packages/*" build`, as CI runs before the tests).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { Chess } from 'chess.js';
import {
  EloCalibrationSchema,
  fallbackElo,
  reviewGame,
  selectEloPlies,
  type EloCalibration,
  type EloCurve,
} from '@daisychess/engine-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Book, type OpeningRow } from '../src/openings/book';
import { findOpening, getBook, loadOpenings } from '../src/openings';
import { computeOpeningFocus } from '../src/review/openingFocus';
import {
  analyzeGame,
  buildBookIndex,
  calibrateElo,
  createGameSplitter,
  decimate,
  DEFAULT_OPENINGS,
  eligibleGame,
  fitCurve,
  formatTable,
  interpolate,
  isotonicDecreasing,
  lastBookPlyOf,
  loadEngineCore,
  monthFromName,
  parseArgs,
  parseEval,
  parseMovetext,
  readLines,
  toEpd,
  type CalibrateOptions,
  type CalibrateSummary,
  type EligibleGame,
} from './calibrate-elo.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const fixture = join(here, 'fixtures/lichess-evaluated-sample.pgn');
const script = join(here, 'calibrate-elo.mjs');
const deployScript = join(repo, 'deploy/calibrate-elo.sh');
const committed = join(here, '../src/review/data/eloCalibration.json');
const fixtureText = readFileSync(fixture, 'utf8');
const rows = JSON.parse(readFileSync(DEFAULT_OPENINGS, 'utf8')) as OpeningRow[];

const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const hasZstdCli = has('zstd');
// zstd in zlib: Node ≥ 22.15 (the @types/node pin predates it).
const zstdZlib = zlib as typeof zlib & { zstdCompressSync?: (b: Buffer) => Buffer };
const hasZlibZstd = typeof zstdZlib.zstdCompressSync === 'function';
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const engineCoreBuilt = existsSync(join(repo, 'packages/engine-core/dist/index.js'));

/** Frame by frame (16 kB each), like a large dump: a truncated file still decodes its head. */
function zstd(data: Buffer): Buffer {
  const frames: Buffer[] = [];
  for (let i = 0; i < data.length; i += 16_384) {
    const part = data.subarray(i, i + 16_384);
    frames.push(
      zstdZlib.zstdCompressSync
        ? zstdZlib.zstdCompressSync(part)
        : execFileSync('zstd', ['-c', '-q'], { input: part }),
    );
  }
  return Buffer.concat(frames);
}

const quiet = () => {};
const opts = (o: Partial<CalibrateOptions>): CalibrateOptions => ({
  input: fixture,
  month: '2026-09',
  minSamples: 20,
  jobs: 1,
  dryRun: true,
  zstdCli: false,
  builtAt: '2026-10-30T00:00:00.000Z',
  ...o,
});

/** Every curve: knots strictly ascending in loss, ratings non-increasing. */
function expectMonotone(table: EloCalibration) {
  const curves = Object.values(table.speeds).filter((c): c is EloCurve => c !== undefined);
  expect(curves.length).toBeGreaterThan(0);
  for (const c of curves) {
    expect(c.knots.length).toBeGreaterThanOrEqual(2);
    expect(c.knots.length).toBeLessThanOrEqual(24);
    c.knots.forEach(([x, y], i) => {
      if (i === 0) return;
      const [px, py] = c.knots[i - 1]!;
      expect(x).toBeGreaterThan(px);
      expect(y).toBeLessThanOrEqual(py);
    });
  }
}

let tmp = '';
let base: CalibrateSummary;
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'calibrate-elo-test-'));
  base = await calibrateElo(opts({}), quiet);
}, 60_000);
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('reads every flag', () => {
    expect(
      parseArgs([
        '--input',
        'a.pgn.zst',
        '--out',
        'o.json',
        '--month',
        '2026-09',
        '--limit',
        '500',
        '--sample',
        '1000',
        '--dump-sha256',
        'AB'.repeat(32),
        '--source',
        'https://x/y.zst',
        '--min-samples',
        '20',
        '--max-knots',
        '16',
        '--openings',
        'o.json',
        '--jobs',
        '3',
        '--built-at',
        '2026-10-30T00:00:00Z',
        '--zstd-cli',
      ]),
    ).toEqual({
      input: 'a.pgn.zst',
      out: 'o.json',
      month: '2026-09',
      limit: 500,
      sample: 1000,
      dumpSha256: 'ab'.repeat(32),
      source: 'https://x/y.zst',
      minSamples: 20,
      maxKnots: 16,
      openings: 'o.json',
      jobs: 3,
      builtAt: '2026-10-30T00:00:00Z',
      dryRun: false,
      zstdCli: true,
    });
    expect(parseArgs(['--input', 'a', '--dry-run']).dryRun).toBe(true);
    expect(parseArgs(['--input', 'a', '--out', 'o', '--month', 'provisional']).month).toBe(
      'provisional',
    );
    expect(parseArgs(['--input', 'a', '--out', 'o', '--sha256', 'C'.repeat(64)]).sha256).toBe(
      'c'.repeat(64),
    );
  });

  it('refuses missing or malformed values', () => {
    expect(() => parseArgs([])).toThrow(/--input is required/);
    expect(() => parseArgs(['--input', 'a'])).toThrow(/--out is required/);
    expect(() => parseArgs(['--input', '--out', 'o'])).toThrow(/--input needs a value/);
    expect(() => parseArgs(['--input', 'a', '--out', 'o', '--limit', '0'])).toThrow(/--limit/);
    expect(() => parseArgs(['--input', 'a', '--out', 'o', '--month', '2026-13'])).toThrow(
      /--month/,
    );
    expect(() => parseArgs(['--input', 'a', '--out', 'o', '--sha256', 'abc'])).toThrow(/64 hex/);
    expect(() => parseArgs(['--input', 'a', '--out', 'o', '--max-knots', '40'])).toThrow(/2…32/);
    expect(() => parseArgs(['--input', 'a', '--out', 'o', '--bogus'])).toThrow(/unknown argument/);
    expect(() =>
      parseArgs(['--input', 'a', '--out', 'o', '--sample', '10', '--sha256', 'a'.repeat(64)]),
    ).toThrow(/cannot verify a --sample/);
  });

  it('takes the month from a lichess dump name', () => {
    expect(monthFromName('/c/lichess_db_standard_rated_2026-09.pgn.zst')).toBe('2026-09');
    expect(monthFromName('/c/range-2000-lichess_db_standard_rated_2025-12.pgn.zst')).toBe(
      '2025-12',
    );
    expect(monthFromName('/c/sample.pgn')).toBeUndefined();
  });
});

describe('PGN parsing', () => {
  it('parses lichess evals (centipawns and mates, White POV)', () => {
    expect(parseEval(' [%eval 0.18] [%clk 0:02:00] ')).toEqual({ cp: 18 });
    expect(parseEval('[%eval -2.05]')).toEqual({ cp: -205 });
    expect(parseEval('[%eval #-3]')).toEqual({ mate: -3 });
    expect(parseEval('[%eval #4,30]')).toEqual({ mate: 4 });
    expect(parseEval('[%clk 0:02:00]')).toBeUndefined();
    expect(parseEval('[%eval abc]')).toBeUndefined();
  });

  it('parses movetext: numbers, suffixes, NAGs, variations, comments, results', () => {
    const r = parseMovetext(
      '1. e4 { [%eval 0.18] } 1... e5?! { [%eval 0.22] [%clk 0:01:00] } 2.Nf3 $1 { a note } ' +
        '(2. f4 { [%eval -0.3] } exf4) 2... Nc6 { [%eval #-2] } 3. Bb5! 1-0',
    );
    expect(r.sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
    expect(r.evals).toEqual([{ cp: 18 }, { cp: 22 }, undefined, { mate: -2 }, undefined]);
  });

  it('splits a line stream into games', () => {
    const s = createGameSplitter();
    const lines = [
      '[Event "Rated Blitz game"]',
      '[WhiteElo "1500"]',
      '',
      '1. e4 e5 1-0',
      '',
      '[Event "Rated Bullet game"]',
      '[TimeControl "60+0"]',
      '',
      '1. d4 { [%eval 0.1] }',
      '1... d5 0-1',
    ];
    const games = lines.map((l) => s.push(l)).filter((g) => g !== undefined);
    games.push(s.flush()!);
    expect(games).toEqual([
      { tags: { Event: 'Rated Blitz game', WhiteElo: '1500' }, movetext: '1. e4 e5 1-0' },
      {
        tags: { Event: 'Rated Bullet game', TimeControl: '60+0' },
        movetext: '1. d4 { [%eval 0.1] } 1... d5 0-1',
      },
    ]);
    expect(s.flush()).toBeUndefined();
  });

  it('filters ineligible games with a reason', () => {
    const tags = {
      Event: 'Rated Blitz game',
      WhiteElo: '1500',
      BlackElo: '1600',
      WhiteRatingDiff: '+5',
      BlackRatingDiff: '-5',
      TimeControl: '180+2',
      Termination: 'Normal',
    };
    const mt = '1. e4 { [%eval 0.2] } 1-0';
    const reason = (t: Record<string, string>, m = mt) => {
      const r = eligibleGame({ tags: t, movetext: m });
      return r.ok ? 'ok' : r.reason;
    };
    expect(eligibleGame({ tags, movetext: mt })).toEqual({
      ok: true,
      game: { white: 1500, black: 1600, timeControl: '180+2', movetext: mt },
    });
    expect(reason(tags, '1. e4 1-0')).toBe('no-eval');
    expect(reason({ ...tags, Event: 'Casual Blitz game' })).toBe('casual');
    expect(reason({ ...tags, Event: 'Blitz swiss https://lichess.org/swiss/x' })).toBe('ok');
    expect(reason({ ...tags, Variant: 'Chess960' })).toBe('variant');
    expect(reason({ ...tags, Variant: 'Standard' })).toBe('ok');
    expect(reason({ ...tags, FEN: '8/8/8/8/8/8/8/8 w - - 0 1', SetUp: '1' })).toBe('setup');
    expect(reason({ ...tags, BlackElo: '?' })).toBe('no-rating');
    const without = (key: keyof typeof tags) =>
      Object.fromEntries(Object.entries(tags).filter(([k]) => k !== key));
    expect(reason(without('WhiteRatingDiff'))).toBe('provisional');
    expect(reason({ ...tags, Termination: 'Abandoned' })).toBe('termination');
    const r = eligibleGame({ tags: without('TimeControl'), movetext: mt });
    expect(r.ok && r.game.timeControl).toBe(undefined);
  });
});

/** The fixture's games (tags + movetext). */
function fixtureGames() {
  const s = createGameSplitter();
  const out = fixtureText
    .split('\n')
    .map((l) => s.push(l))
    .filter((g) => g !== undefined);
  const last = s.flush();
  if (last) out.push(last);
  return out;
}

/** SAN line and EPDs (index = ply) of a SAN sequence replayed with chess.js. */
function replay(sans: readonly string[]) {
  const c = new Chess();
  const epds = [toEpd(c.fen())];
  const played: string[] = [];
  for (const san of sans) {
    played.push(c.move(san).san);
    epds.push(toEpd(c.fen()));
  }
  return { sans: played, epds };
}

describe('book check (the app rule)', () => {
  const book = new Book(rows);
  const index = buildBookIndex(rows);

  it('agrees with Book.inBook on every prefix of 50 lines', () => {
    const lines: string[][] = [];
    // 30 real game openings (16 plies) …
    for (const g of fixtureGames().slice(0, 30)) {
      lines.push(parseMovetext(g.movetext).sans.slice(0, 16));
    }
    // … and 10 book lines (spread over the table), each also with its last move replaced by
    // another legal move (usually out of book).
    for (let k = 0; k < 10; k++) {
      const line = rows[Math.floor((k * rows.length) / 10) + 7]![3].split(' ');
      const c = new Chess();
      for (const san of line.slice(0, -1)) c.move(san);
      const other = c.moves().find((m) => m !== line[line.length - 1])!;
      lines.push(line, [...line.slice(0, -1), other]);
    }
    expect(lines).toHaveLength(50);
    let checks = 0;
    let inBook = 0;
    for (const line of lines) {
      for (let n = 0; n <= line.length; n++) {
        const prefix = line.slice(0, n);
        expect(index.inBook(prefix), prefix.join(' ')).toBe(book.inBook(prefix));
        checks++;
        if (book.inBook(prefix)) inBook++;
      }
    }
    // Both outcomes are exercised.
    expect(inBook).toBeGreaterThan(50);
    expect(checks - inBook).toBeGreaterThan(50);
  });

  it('finds the same book end as computeOpeningFocus on every fixture game', async () => {
    await loadOpenings();
    const appBook = getBook()!;
    for (const g of fixtureGames()) {
      const { sans, epds } = replay(parseMovetext(g.movetext).sans);
      const focus = computeOpeningFocus({ sans, epds, book: appBook, findOpening });
      expect(lastBookPlyOf(index, sans, epds)).toBe(focus.lastBookPly);
    }
  });

  it('follows a transposition into a named position', () => {
    // 1. Nf3 d5 2. d4 reaches the Queen's Pawn position of 1. d4 d5 2. Nf3 by another order.
    const { sans, epds } = replay(['Nf3', 'd5', 'd4', 'Nf6', 'c4', 'e6', 'a3']);
    const expected = computeOpeningFocus({
      sans,
      epds,
      book: new Book(rows),
      findOpening: (positions) => {
        for (let i = positions.length - 1; i >= 0; i--) {
          const r = rows.find((row) => row[2] === positions[i]);
          if (r) return { eco: r[0], name: r[1], ply: i, moves: r[3].split(' ') };
        }
        return null;
      },
    }).lastBookPly;
    expect(lastBookPlyOf(index, sans, epds)).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(6);
  });
});

describe('analyzeGame', () => {
  const book = buildBookIndex(rows);
  const tc = '180+0';
  // An Italian game where both sides shuffle out of book and keep the eval level for long
  // enough (≥ 10 scored positions each), then White blunders.
  const shuffle = [
    'e4',
    'e5',
    'Nf3',
    'Nc6',
    'Bc4',
    'Bc5',
    'c3',
    'Nf6',
    'd3',
    'd6',
    'O-O',
    'O-O',
    'h3',
    'h6',
    'Re1',
    'a6',
    'a4',
    'Ba7',
    'Nbd2',
    'Re8',
    'Nf1',
    'Be6',
    'Bxe6',
    'Rxe6',
    'Ng3',
    'Qd7',
    'Be3',
    'Bxe3',
    'Rxe3',
    'Rae8',
    'Qb3',
    'Na5',
    'Qc2',
    'Nc6',
    'b4',
    'Ne7',
    'c4',
    'Ng6',
    'Nf5',
    'Nh5',
    'Qd2',
    'Nhf4',
  ];
  const movetext = (evals: (string | null)[], sans = shuffle) =>
    sans
      .map((san, i) => {
        const e = evals[i];
        const num = i % 2 === 0 ? `${i / 2 + 1}. ` : `${(i - 1) / 2 + 1}... `;
        return `${num}${san}${e === null || e === undefined ? '' : ` { [%eval ${e}] }`}`;
      })
      .join(' ');
  // A slow slide towards Black: every White move loses a little, every Black move gains.
  const level = shuffle.map((_, i) => (0.5 - 0.05 * i).toFixed(2));

  it('reproduces the app review and selection (mean loss of the scored plies)', async () => {
    const E = await loadEngineCore();
    const game: EligibleGame = {
      white: 1500,
      black: 1700,
      timeControl: tc,
      movetext: movetext(level),
    };
    const r = analyzeGame(E, book, game);
    expect(r.reason).toBeUndefined();
    expect(r.samples.map((s) => s.rating)).toEqual([1500, 1700]);
    expect(r.samples.every((s) => s.speed === 'blitz')).toBe(true);
    // Recompute independently: positions with chess.js, the review, the book end of the app.
    const { sans, epds } = replay(shuffle);
    const c = new Chess();
    const fens = [c.fen()];
    const moves = sans.map((san) => {
      const legalMoves = c.moves().length;
      const m = c.move(san);
      fens.push(c.fen());
      return { uci: m.from + m.to, san: m.san, legalMoves };
    });
    const scores = [{ cp: 20 }, ...level.map((v) => ({ cp: Math.round(Number(v) * 100) }))];
    const summary = reviewGame({
      positions: fens.map((fen, k) => ({ fen, eval: scores[k]! })),
      moves,
    });
    const reviewed = summary.moves.map((m, k) => ({ ...m, legalMoves: moves[k]!.legalMoves }));
    const last = lastBookPlyOf(book, sans, epds);
    for (const [k, side] of (['white', 'black'] as const).entries()) {
      const sel = selectEloPlies(reviewed, side, last);
      expect(sel.length).toBeGreaterThanOrEqual(10);
      const mean = sel.reduce((s, m) => s + m.winProbLoss, 0) / sel.length;
      expect(r.samples[k]!.meanLoss).toBeCloseTo(mean, 10);
      expect(r.samples[k]!.positions).toBe(sel.length);
    }
    expect(r.samples[0]!.meanLoss).toBeGreaterThan(0);
    expect(r.samples[1]!.meanLoss).toBe(0);
  });

  it('rejects a game with a missing eval, an illegal move, or too few positions', async () => {
    const E = await loadEngineCore();
    const holes: (string | null)[] = [...level];
    holes[20] = null;
    expect(analyzeGame(E, book, { white: 1, black: 1, movetext: movetext(holes) }).reason).toBe(
      'missing-eval',
    );
    const bad = [...shuffle];
    bad[30] = 'Qh8';
    expect(
      analyzeGame(E, book, { white: 1, black: 1, movetext: movetext(level, bad) }).reason,
    ).toBe('illegal');
    const short = shuffle.slice(0, 20);
    expect(
      analyzeGame(E, book, { white: 1, black: 1, movetext: movetext(level, short) }).reason,
    ).toBe('too-few-positions');
    // Decided positions (|eval| ≥ 5) are not scored either.
    const decided = shuffle.map(() => '6.00');
    expect(analyzeGame(E, book, { white: 1, black: 1, movetext: movetext(decided) }).reason).toBe(
      'too-few-positions',
    );
  });

  it('accepts a final checkmate without an eval', async () => {
    const E = await loadEngineCore();
    const mate = ['f3', 'e5', 'g4', 'Qh4#'];
    const r = analyzeGame(E, book, {
      white: 1,
      black: 1,
      movetext: movetext(['0.1', '0.2', '#-1', null], mate),
    });
    expect(r.reason).toBe('too-few-positions');
    const missing = analyzeGame(E, book, {
      white: 1,
      black: 1,
      movetext: movetext(['0.1', '0.2', '#-1', null], ['f3', 'e5', 'g4', 'Nc6']),
    });
    expect(missing.reason).toBe('missing-eval');
  });
});

describe('isotonic fit', () => {
  it('pools adjacent violators into a non-increasing step function', () => {
    const blocks = isotonicDecreasing([
      [1, 2000],
      [2, 1800],
      [3, 1900],
      [4, 1500],
      [5, 1600],
      [6, 1400],
    ]);
    expect(blocks).toEqual([
      { x: 1, y: 2000, w: 1 },
      { x: 2.5, y: 1850, w: 2 },
      { x: 4.5, y: 1550, w: 2 },
      { x: 6, y: 1400, w: 1 },
    ]);
  });

  it('pools equal x first, then merges an increasing run into one block', () => {
    expect(
      isotonicDecreasing([
        [2, 1000],
        [1, 1000],
        [1, 1200],
        [3, 1500],
      ]),
    ).toEqual([{ x: 1.75, y: 1175, w: 4 }]);
  });

  it('decimates to at most maxKnots equal-weight groups, keeping weight and monotony', () => {
    const blocks = Array.from({ length: 100 }, (_, i) => ({
      x: i,
      y: 2000 - i * 7,
      w: 1 + (i % 3),
    }));
    const d = decimate(blocks, 24);
    expect(d.length).toBeLessThanOrEqual(24);
    expect(d.length).toBeGreaterThanOrEqual(20);
    expect(d.reduce((s, b) => s + b.w, 0)).toBe(blocks.reduce((s, b) => s + b.w, 0));
    for (let i = 1; i < d.length; i++) {
      expect(d[i]!.x).toBeGreaterThan(d[i - 1]!.x);
      expect(d[i]!.y).toBeLessThanOrEqual(d[i - 1]!.y);
    }
    expect(decimate(blocks.slice(0, 5), 24)).toHaveLength(5);
    // One heavy block does not overflow the group count.
    const heavy = [{ x: 0, y: 9, w: 1000 }, ...blocks];
    expect(decimate(heavy, 24).length).toBeLessThanOrEqual(24);
  });

  it('interpolates linearly and stays flat beyond the ends (as fallbackElo)', () => {
    const k: [number, number][] = [
      [2, 1800],
      [6, 1400],
    ];
    expect(interpolate(k, 0)).toBe(1800);
    expect(interpolate(k, 4)).toBe(1600);
    expect(interpolate(k, 9)).toBe(1400);
  });

  it('recovers a noisy decreasing relation with a sensible residual sd', () => {
    // Deterministic pseudo-noise, sd ≈ 200.
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pts: [number, number][] = [];
    for (let i = 0; i < 4000; i++) {
      const x = rnd() * 20;
      const noise = (rnd() + rnd() + rnd() - 1.5) * 400;
      pts.push([x, 2200 - 50 * x + noise]);
    }
    const c = fitCurve(pts, 24)!;
    expect(c.knots.length).toBeLessThanOrEqual(24);
    expect(c.residualSd).toBeGreaterThan(150);
    expect(c.residualSd).toBeLessThan(260);
    expect(interpolate(c.knots, 10)).toBeGreaterThan(1600);
    expect(interpolate(c.knots, 10)).toBeLessThan(1800);
    expect(EloCalibrationSchema.shape.speeds.shape.unknown.parse(c)).toEqual(c);
  });

  it('gives no curve for fewer than two distinct knots', () => {
    expect(fitCurve([])).toBeUndefined();
    expect(fitCurve([[3, 1500]])).toBeUndefined();
    expect(
      fitCurve([
        [3, 1500],
        [3.001, 1400],
      ]),
    ).toBeUndefined();
  });
});

describe('calibrateElo on the fixture', () => {
  it('reads the 211 games, keeps the 197 eligible ones and counts the skips', () => {
    expect(base.gamesRead).toBe(211);
    expect(base.analyzed).toBe(197);
    expect(base.rejects['no-eval']).toBe(11);
    expect(base.rejects.provisional).toBe(3);
    expect(base.used).toBeGreaterThan(150);
    expect(base.used).toBe(base.table.source.games);
    // `unknown` pools every class plus the games without a usable TimeControl (correspondence).
    expect(base.samples.unknown).toBeGreaterThan(
      base.samples.bullet! + base.samples.blitz! + base.samples.rapid! + base.samples.classical!,
    );
    expect(base.partial).toBe(false);
    expect(base.sha256).toBe(sha256(readFileSync(fixture)));
  });

  it('produces a valid table with monotone knots in every speed class', () => {
    expect(EloCalibrationSchema.parse(base.table)).toEqual(base.table);
    expect(base.table.source.month).toBe('2026-09');
    expect(Object.keys(base.table.speeds).sort()).toEqual([
      'blitz',
      'bullet',
      'classical',
      'rapid',
      'unknown',
    ]);
    expectMonotone(base.table);
    // Less loss never maps to a lower rating, and the curve spans a plausible range.
    const lo = fallbackElo(1, 'unknown', base.table).rating;
    const hi = fallbackElo(15, 'unknown', base.table).rating;
    expect(lo).toBeGreaterThan(hi);
    expect(lo).toBeLessThan(2600);
    expect(hi).toBeGreaterThan(600);
  });

  it('omits speed classes below --min-samples (the app falls back to unknown)', async () => {
    const s = await calibrateElo(opts({ minSamples: 100 }), quiet);
    expect(s.table.speeds.classical).toBeUndefined();
    expect(s.table.speeds.blitz).toBeDefined();
    expect(s.table.speeds.unknown).toEqual(base.table.speeds.unknown);
    await expect(calibrateElo(opts({ minSamples: 100_000 }), quiet)).rejects.toThrow(
      /samples in total/,
    );
  }, 60_000);

  it('gives the same table with worker threads', async () => {
    const s = await calibrateElo(opts({ jobs: 3 }), quiet);
    expect(s.table).toEqual(base.table);
    expect(s.rejects).toEqual(base.rejects);
  }, 60_000);

  it('stops after --limit eligible games', async () => {
    const s = await calibrateElo(opts({ limit: 60 }), quiet);
    expect(s.analyzed).toBe(60);
    expect(s.gamesRead).toBeLessThan(211);
  }, 60_000);

  it('writes the table and SOURCE.md, and fails closed on a digest mismatch', async () => {
    const out = join(tmp, 'write/eloCalibration.json');
    await calibrateElo(opts({ dryRun: false, out, source: 'https://example/x.pgn.zst' }), quiet);
    const json = readFileSync(out, 'utf8');
    expect(json).toBe(formatTable(base.table));
    expect(JSON.parse(json)).toEqual(base.table);
    const md = readFileSync(join(tmp, 'write/SOURCE.md'), 'utf8');
    expect(md).toContain(base.sha256);
    expect(md).toContain('https://example/x.pgn.zst');
    expect(md).not.toContain('Provisional');
    await expect(calibrateElo(opts({ sha256: '0'.repeat(64) }), quiet)).rejects.toThrow(
      /sha256 mismatch/,
    );
    await expect(calibrateElo(opts({ month: undefined, input: fixture }), quiet)).rejects.toThrow(
      /--month is required/,
    );
  }, 60_000);
});

describe('stream reader', () => {
  const zstPath = () => {
    const p = join(tmp, 'lichess_db_standard_rated_2026-09.pgn.zst');
    if (!existsSync(p)) writeFileSync(p, zstd(Buffer.from(fixtureText)));
    return p;
  };
  const collect = async (path: string, o: { sample?: number; zstdCli?: boolean } = {}) => {
    const info = { bytes: 0, partial: false };
    const lines: string[] = [];
    for await (const l of readLines(path, o, info)) lines.push(l);
    return { lines, ...info };
  };

  it.runIf(hasZlibZstd || hasZstdCli)(
    'calibrates from zstd identically (month from the name)',
    async () => {
      const s = await calibrateElo(opts({ input: zstPath(), month: undefined }), quiet);
      expect(s.table.speeds).toEqual(base.table.speeds);
      expect(s.month).toBe('2026-09');
    },
    60_000,
  );

  it.runIf(hasZstdCli)('decompresses with the zstd CLI fallback', async () => {
    const r = await collect(zstPath(), { zstdCli: true });
    expect(r.lines.join('\n')).toBe(fixtureText.replace(/\n$/, ''));
  });

  for (const cli of [false, true]) {
    it.runIf(cli ? hasZstdCli : hasZlibZstd || hasZstdCli)(
      `a truncated zstd file fails without --sample and is tolerated with it (${cli ? 'CLI' : 'zlib'})`,
      async () => {
        const full = readFileSync(zstPath());
        const half = Math.floor(full.length / 2);
        const cut = join(tmp, `cut-${cli}.pgn.zst`);
        writeFileSync(cut, full.subarray(0, half));
        await expect(collect(cut, { zstdCli: cli })).rejects.toThrow();
        const r = await collect(zstPath(), { sample: half, zstdCli: cli });
        expect(r.partial).toBe(true);
        expect(r.lines.length).toBeGreaterThan(100);
        // Only whole lines of the fixture come out.
        const all = new Set(fixtureText.split('\n'));
        for (const l of r.lines) expect(all.has(l)).toBe(true);
      },
    );
  }

  it.runIf(hasZlibZstd || hasZstdCli)(
    'calibrates a ranged sample, dropping the cut game',
    async () => {
      const p = zstPath();
      const s = await calibrateElo(
        opts({ input: p, sample: Math.floor(statSync(p).size * 0.7) }),
        quiet,
      );
      expect(s.partial).toBe(true);
      expect(s.gamesRead).toBeLessThan(211);
      expect(s.gamesRead).toBeGreaterThan(100);
      expect(s.rejects.illegal ?? 0).toBe(0);
      expect(s.rejects['missing-eval'] ?? 0).toBe(0);
    },
    60_000,
  );

  it('drops the cut last line of a partial plain read', async () => {
    const r = await collect(fixture, { sample: 1000 });
    expect(r.partial).toBe(true);
    expect(r.lines.join('\n').length).toBeLessThan(1000);
    expect(fixtureText.startsWith(r.lines.join('\n'))).toBe(true);
  });
});

describe('the committed table', () => {
  it('validates, is monotone and is flagged in SOURCE.md', () => {
    const table = EloCalibrationSchema.parse(JSON.parse(readFileSync(committed, 'utf8')));
    expectMonotone(table);
    expect(readFileSync(committed, 'utf8')).toBe(formatTable(table));
    const md = readFileSync(join(dirname(committed), 'SOURCE.md'), 'utf8');
    expect(md).toContain(table.source.sha256!);
    if (table.source.month === 'provisional') expect(md).toMatch(/Provisional table/);
    else expect(md).toContain(table.source.month);
  });
});

describe.runIf(engineCoreBuilt)('the CLI', () => {
  it('exits 2 on usage errors, 1 on failures, 0 with the table printed', () => {
    expect(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status).toBe(2);
    const bad = spawnSync(
      process.execPath,
      [script, '--input', fixture, '--dry-run', '--month', '2026-09', '--sha256', '0'.repeat(64)],
      { encoding: 'utf8' },
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/sha256 mismatch/);
    const ok = spawnSync(
      process.execPath,
      [
        script,
        '--input',
        fixture,
        '--dry-run',
        '--month',
        '2026-09',
        '--min-samples',
        '20',
        '--jobs',
        '2',
      ],
      { encoding: 'utf8' },
    );
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/games read 211, evaluated and eligible 197/);
    expect(ok.stdout).toMatch(/^unknown\s+\d+\s+\d+/m);
  }, 60_000);
});

const deployTools = ['bash', 'curl', 'sha256sum', 'pnpm', 'df'].every(has);

describe.runIf(engineCoreBuilt && deployTools && (hasZlibZstd || hasZstdCli))(
  'deploy/calibrate-elo.sh',
  () => {
    let dir = '';
    let env: Record<string, string> = {};
    let dump = '';
    const name = 'lichess_db_standard_rated_2026-09.pgn.zst';

    const run = (args: string[] = [], extra: Record<string, string> = {}) =>
      spawnSync('bash', [deployScript, '--no-install', '--month', '2026-09', ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...env, ...extra },
        timeout: 120_000,
      });
    const sums = (digest: string) =>
      writeFileSync(
        join(dir, 'remote/sha256sums.txt'),
        `${'0'.repeat(64)}  lichess_db_standard_rated_2026-08.pgn.zst\n${digest}  ${name}\n`,
      );

    beforeAll(() => {
      dir = join(tmp, 'deploy');
      mkdirSync(join(dir, 'remote'), { recursive: true });
      dump = join(dir, 'remote', name);
      writeFileSync(dump, zstd(Buffer.from(fixtureText)));
      sums(sha256(readFileSync(dump)));
      env = {
        PUZZLE_CACHE_DIR: join(dir, 'cache'),
        ELO_CALIBRATION_OUT: join(dir, 'repo-data/eloCalibration.json'),
        LICHESS_DB_BASE_URL: `file://${join(dir, 'remote')}`,
        CALIBRATE_MIN_SAMPLES: '20',
        CALIBRATE_JOBS: '1',
        FREE_SPACE_MARGIN_MB: '0',
        // engine-core was built before the tests; rebuilding dist here would race other tests.
        ELO_SKIP_BUILD: '1',
      };
    });

    it('downloads, verifies and writes the table + SOURCE.md', () => {
      const r = run();
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Downloading/);
      expect(r.stdout).toMatch(/eloCalibration\.json \+ SOURCE\.md/);
      const table = EloCalibrationSchema.parse(
        JSON.parse(readFileSync(env.ELO_CALIBRATION_OUT!, 'utf8')),
      );
      expect(table.source).toEqual({
        month: '2026-09',
        games: base.used,
        sha256: sha256(readFileSync(dump)),
      });
      expect(table.speeds).toEqual(base.table.speeds);
      const md = readFileSync(join(dir, 'repo-data/SOURCE.md'), 'utf8');
      expect(md).toContain(`file://${dump}`);
    }, 120_000);

    it('uses the verified cache when the listed digest is unchanged', () => {
      rmSync(dump);
      const r = run();
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Cached dump is current/);
      writeFileSync(dump, zstd(Buffer.from(fixtureText)));
    }, 120_000);

    it('fails closed on a digest mismatch and on a tampered cache, writing nothing', () => {
      const before = readFileSync(env.ELO_CALIBRATION_OUT!);
      sums('a'.repeat(64));
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/expected a{64}/);
      expect(existsSync(join(env.PUZZLE_CACHE_DIR!, `${name}.part`))).toBe(false);
      sums(sha256(readFileSync(dump)));
      const cached = join(env.PUZZLE_CACHE_DIR!, name);
      writeFileSync(cached, Buffer.concat([readFileSync(cached), Buffer.from('x')]));
      const t = run();
      expect(t.status).toBe(1);
      expect(t.stderr).toMatch(/marked stale/);
      expect(readFileSync(env.ELO_CALIBRATION_OUT!)).toEqual(before);
      // The next run downloads again and succeeds.
      rmSync(cached);
      expect(run().status).toBe(0);
    }, 120_000);

    it('refuses a month lichess does not list', () => {
      const r = spawnSync('bash', [deployScript, '--no-install', '--month', '2026-07'], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/lists 0 digests/);
    });

    it('--range downloads a resumable prefix and calibrates it as a sample', () => {
      const size = statSync(dump).size;
      const range = Math.floor(size * 0.7);
      const prefix = join(env.PUZZLE_CACHE_DIR!, `range-${range}-${name}`);
      // An interrupted earlier run left the first 1000 bytes.
      mkdirSync(dirname(prefix), { recursive: true });
      writeFileSync(prefix, readFileSync(dump).subarray(0, 1000));
      writeFileSync(`${prefix}.dump-sha256`, `${sha256(readFileSync(dump))}\n`);
      const out = join(dir, 'range-data/eloCalibration.json');
      const r = run(['--range', String(range)], { ELO_CALIBRATION_OUT: out });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/bytes 1000-/);
      expect(readFileSync(prefix)).toEqual(readFileSync(dump).subarray(0, range));
      const md = readFileSync(join(dir, 'range-data/SOURCE.md'), 'utf8');
      expect(md).toMatch(/Partial read/);
      expect(md).toContain(sha256(readFileSync(dump)));
      // Cached and complete on the second run; discarded when the dump digest changes.
      expect(run(['--range', String(range)], { ELO_CALIBRATION_OUT: out }).stdout).toMatch(
        /Cached prefix is complete/,
      );
      sums('b'.repeat(64));
      const changed = run(['--range', String(range), '--dry-run']);
      expect(changed.stdout).toMatch(/another version of the dump: discarded/);
      sums(sha256(readFileSync(dump)));
    }, 120_000);

    it('refuses a download that does not fit the free disk space', () => {
      const r = run(['--range', '1000'], {
        PUZZLE_CACHE_DIR: join(dir, 'cache2'),
        FREE_SPACE_MARGIN_MB: String(1024 * 1024 * 1024),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/MB free/);
    });
  },
);
