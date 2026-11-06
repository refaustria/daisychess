/// <reference types="node" />
// The Syzygy reader against the committed core tables (apps/web/public/endgames/v1/) and the
// reference answers of the lichess tablebase API (test/fixtures/tb-reference.json, written once
// by scripts/make-tb-fixtures.mjs --from-api). The KRPvKR part needs the rook pack in the cache
// directory and runs only with DAISYCHESS_SLOW_TESTS=1 (fetch it with
// `node packages/endgames/scripts/fetch-tables.mjs --pack rook`).
import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TABLES_MAX_BYTES, TablesManifestSchema, packBytes, tableFileName } from '../manifest.js';
import { opponentMove } from '../opponent.js';
import { judgeMove, keepers } from '../tablebase/judge.js';
import type { TbPosition } from '../tablebase/types.js';
import { TbBoard, TbBoardError } from './board.js';
import { requiredTables } from './names.js';
import { SyzygyFormatError } from './table.js';
import { MissingTableError, SyzygyTables } from './tablebase.js';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const CORE_DIR = here('../../../../apps/web/public/endgames/v1/');
const MANIFEST = TablesManifestSchema.parse(
  JSON.parse(readFileSync(here('../../tables.manifest.json'), 'utf8')),
);

interface RefPosition {
  fen: string;
  material: string;
  category: string;
  /** `15`, `~16` (rounded), `-` (absent) */
  dtz: string;
  checkmate: boolean;
  stalemate: boolean;
  /** `"<uci> <category> <dtz>"` */
  moves: string[];
}
const REFERENCE = JSON.parse(
  readFileSync(here('../../test/fixtures/tb-reference.json'), 'utf8'),
) as {
  format: 1;
  positions: RefPosition[];
};

const bytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));

function loadDir(tb: SyzygyTables, dir: string, names?: Set<string>): void {
  for (const f of readdirSync(dir)) {
    if (/^[KQRBNPv]+\.rtb[wz]$/.test(f) && (!names || names.has(f)))
      tb.addTable(f, bytes(join(dir, f)));
  }
}

const core = new SyzygyTables();
loadDir(core, CORE_DIR);

const num = (dtz: string): number | undefined =>
  dtz === '-' ? undefined : Number(dtz.replace('~', ''));

/** Differences between the reader's answer and the API's; empty when they agree. */
function compare(tb: SyzygyTables, ref: RefPosition): string[] {
  const pos = tb.probePosition(ref.fen);
  if (!pos) return [`${ref.fen}: no local result`];
  const diffs: string[] = [];
  const where = (s: string): string => `${ref.fen}: ${s}`;
  if (pos.category !== ref.category)
    diffs.push(where(`category ${pos.category} != ${ref.category}`));
  if (pos.dtz !== undefined && pos.dtz !== num(ref.dtz))
    diffs.push(where(`dtz ${pos.dtz} != ${ref.dtz}`));
  if (tb.has(ref.material, 'dtz') && pos.dtz === undefined) diffs.push(where('dtz missing'));
  const api = new Map(
    ref.moves
      .map((m) => m.split(' ') as [string, string, string])
      .map(([u, c, d]) => [u, { c, d }]),
  );
  if (api.size !== pos.moves.length) diffs.push(where(`${pos.moves.length} moves != ${api.size}`));
  for (const m of pos.moves) {
    const a = api.get(m.uci);
    if (!a) {
      diffs.push(where(`extra move ${m.uci}`));
      continue;
    }
    if (m.category !== a.c) diffs.push(where(`${m.uci} category ${m.category} != ${a.c}`));
    if (m.dtz !== undefined && m.dtz !== num(a.d))
      diffs.push(where(`${m.uci} dtz ${m.dtz} != ${a.d}`));
  }
  return diffs;
}

/** Random legal FENs of a material (deterministic), like scripts/make-tb-fixtures.mjs. */
function randomFens(material: string, n: number, seed: number): string[] {
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const [w = '', b = ''] = material.split('v');
  const out: string[] = [];
  while (out.length < n) {
    const sq: string[] = new Array<string>(64).fill('');
    for (const l of [...w.toUpperCase(), ...b.toLowerCase()]) {
      let s: number;
      do s = Math.floor(rnd() * 64);
      while (sq[s] || (l.toLowerCase() === 'p' && (s < 8 || s >= 56)));
      sq[s] = l;
    }
    const rows: string[] = [];
    for (let r = 7; r >= 0; r--) {
      rows.push(
        sq
          .slice(r * 8, r * 8 + 8)
          .map((p) => p || '1')
          .join('')
          .replace(/1+/g, (m) => String(m.length)),
      );
    }
    const fen = `${rows.join('/')} ${rnd() < 0.5 ? 'w' : 'b'} - - 0 1`;
    try {
      TbBoard.fromFen(fen);
      out.push(fen);
    } catch {
      // the side not to move is in check: draw again
    }
  }
  return out;
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('core tables and manifest', () => {
  const coreEntries = MANIFEST.tables.filter((t) => t.pack === 'core');

  it('keeps the bundled core pack within TABLES_MAX_BYTES', () => {
    expect(packBytes(MANIFEST, 'core')).toBeLessThanOrEqual(TABLES_MAX_BYTES);
  });

  it('commits exactly the core files of the manifest, byte for byte', () => {
    const onDisk = readdirSync(CORE_DIR)
      .filter((f) => /\.rtb[wz]$/.test(f))
      .sort();
    expect(onDisk).toEqual(coreEntries.map(tableFileName).sort());
    for (const t of coreEntries) {
      const b = bytes(join(CORE_DIR, tableFileName(t)));
      expect(b.length, tableFileName(t)).toBe(t.bytes);
      expect(sha256(b), tableFileName(t)).toBe(t.sha256);
    }
  });

  it('holds every WDL table that probing the lesson materials and their children needs', () => {
    const wdl = (pack: string[]) =>
      new Set(
        MANIFEST.tables.filter((t) => t.kind === 'wdl' && pack.includes(t.pack)).map((t) => t.name),
      );
    const coreWdl = wdl(['core']);
    for (const m of ['KQvK', 'KRvK', 'KPvK', 'KBBvK', 'KBNvK', 'KQvKP']) {
      expect(
        requiredTables(m).filter((n) => !coreWdl.has(n)),
        m,
      ).toEqual([]);
      expect(core.missing(m)).toEqual([]);
    }
    const all = wdl(['core', 'rook']);
    expect(requiredTables('KRPvKR').filter((n) => !all.has(n))).toEqual([]);
    // DTZ: the basic mates and K+P vs K; KQvKP is WDL-only (budget, see SOURCE.md).
    for (const m of ['KQvK', 'KRvK', 'KPvK', 'KBBvK', 'KBNvK'])
      expect(core.has(m, 'dtz'), m).toBe(true);
    expect(core.has('KQvKP', 'dtz')).toBe(false);
    expect(MANIFEST.tables.filter((t) => t.pack === 'rook' && t.kind === 'dtz')).toEqual([]);
  });
});

describe('SyzygyTables on the core tables', () => {
  const coreRefs = REFERENCE.positions.filter((p) => p.material !== 'KRPvKR');

  it('has a few hundred reference positions per core material', () => {
    const per = new Map<string, number>();
    for (const p of coreRefs) per.set(p.material, (per.get(p.material) ?? 0) + 1);
    for (const m of ['KQvK', 'KRvK', 'KPvK', 'KBBvK', 'KBNvK', 'KQvKP']) {
      expect(per.get(m) ?? 0, m).toBeGreaterThanOrEqual(250);
    }
  });

  it('matches the lichess API on every reference position (category, DTZ, every move)', () => {
    const diffs = coreRefs.flatMap((ref) => compare(core, ref));
    expect(diffs.slice(0, 20)).toEqual([]);
  }, 60_000);

  it('is consistent with its own children on random positions (negamax of the result sign)', () => {
    let checked = 0;
    for (const [material, seed] of [
      ['KQvK', 11],
      ['KRvK', 12],
      ['KPvK', 13],
      ['KBBvK', 14],
      ['KBNvK', 15],
      ['KQvKP', 16],
    ] as const) {
      for (const fen of randomFens(material, 150, seed)) {
        const pos = core.probePosition(fen);
        expect(pos, fen).not.toBeNull();
        if (!pos || pos.moves.length === 0) continue;
        const sign = (c: string): number =>
          c === 'win' || c === 'cursed-win' ? 1 : c === 'draw' ? 0 : -1;
        const best = Math.max(...pos.moves.map((m) => -sign(m.category))) || 0;
        expect(best, fen).toBe(sign(pos.category));
        if (pos.dtz !== undefined && pos.category === 'win') {
          // the fastest winning move is one ply closer to zeroing (or zeroes)
          const next = pos.moves.filter(
            (m) => m.category === 'loss' && !m.zeroing && m.dtz !== undefined,
          );
          const zeroes = pos.moves.some((m) => (m.zeroing || m.checkmate) && m.category === 'loss');
          if (zeroes) expect(pos.dtz, fen).toBe(1);
          else if (next.length > 0) {
            expect(Math.max(...next.map((m) => m.dtz!)), fen).toBe(-(pos.dtz - 1));
          }
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(800);
  }, 60_000);

  it('probes WDL and DTZ (python-chess documentation example)', () => {
    expect(core.probeWdl('8/2K5/4B3/3N4/8/8/4k3/8 b - - 0 1')).toBe(-2);
    // python-chess documents -53 with the rounded 3-4-5-dtz table; the unrounded dtz-nr table
    // we ship stores plies and gives the precise -54 (lichess: dtz -54, precise_dtz -54).
    expect(core.probeDtz('8/2K5/4B3/3N4/8/8/4k3/8 b - - 0 1')).toBe(-54);
    expect(core.probeWdl('8/8/8/8/8/8/8/K6k w - - 0 1')).toBe(0);
    expect(core.probeDtz('8/8/8/8/8/8/8/K6k w - - 0 1')).toBe(0);
  });

  it('draws K+B vs K and K+N vs K without a table', () => {
    expect(core.has('KBvK', 'wdl')).toBe(false);
    expect(core.probeWdl('8/8/8/8/8/2B5/8/K6k b - - 0 1')).toBe(0);
    expect(core.probeDtz('8/8/8/8/8/2n5/8/K6k w - - 0 1')).toBe(0);
    const pos = core.probePosition('8/8/8/8/8/2B5/8/K6k b - - 0 1')!;
    expect(pos.category).toBe('draw');
    expect(pos.moves.every((m) => m.category === 'draw')).toBe(true);
  });

  it('resolves captures and promotions into other tables (KQvKP → KQvKQ … KQvKN, KQvK)', () => {
    const childCategory = (fen: string, uci: string): string | undefined => {
      const chess = new Chess(fen);
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      return core.probePosition(chess.fen())?.category;
    };
    // Black's pawn on b2 promotes (to all four pieces; KQvKQ, KQvKR, KQvKB, KQvKN).
    const promo = core.probePosition('K7/8/8/8/8/8/1pk5/7Q b - - 0 1')!;
    expect(promo).not.toBeNull();
    for (const p of ['q', 'r', 'b', 'n']) {
      const m = promo.moves.find((x) => x.uci === `b2b1${p}`)!;
      expect(m.zeroing).toBe(true);
      expect(m.category).toBe(childCategory(promo.fen, m.uci));
    }
    // The queen takes the pawn with check: KQvK, and the king takes the queen back (draw).
    const pos = core.probePosition('8/8/8/8/8/1Q6/2p5/K1k5 w - - 0 1')!;
    const take = pos.moves.find((m) => m.uci === 'b3c2')!;
    expect(take).toMatchObject({ zeroing: true, category: 'draw', dtz: 0, checkmate: false });
    expect(take.category).toBe(childCategory(pos.fen, 'b3c2'));
  });

  it('reports mate and stalemate like lichess', () => {
    const mate = core.probePosition('k7/1Q6/1K6/8/8/8/8/8 b - - 0 1')!;
    expect(mate).toMatchObject({ category: 'loss', moves: [] });
    const stale = core.probePosition('k7/2Q5/1K6/8/8/8/8/8 b - - 0 1')!;
    expect(stale).toMatchObject({ category: 'draw', moves: [] });
    const toMate = core.probePosition('k7/8/1K6/8/8/8/8/2Q5 w - - 0 1')!;
    const mates = toMate.moves.filter((m) => m.checkmate);
    expect(mates.length).toBeGreaterThan(0);
    for (const m of mates) expect(m.category).toBe('loss');
  });

  it('applies the 50-move counter like lichess when the DTZ is known', () => {
    // KBNvK: Black to move loses with DTZ -54 at a fresh counter …
    const fen = '8/2K5/4B3/3N4/8/8/4k3/8 b - - 0 1';
    expect(core.probePosition(fen)!.category).toBe('loss');
    // … but with 50 plies already gone the 50-move rule saves Black (54 + 50 > 100).
    expect(core.probePosition(fen.replace(' 0 1', ' 50 80'))!.category).toBe('blessed-loss');
    expect(core.probePosition(fen.replace(' 0 1', ' 46 80'))!.category).toBe('loss');
  });

  it('gives DTZ only where the DTZ table is loaded (KQvKP is WDL-only)', () => {
    expect(core.probeDtz('8/8/8/8/8/1Q6/2p5/K1k5 w - - 0 1')).toBeNull();
    const pos = core.probePosition('8/8/8/8/8/1Q6/2p5/K1k5 w - - 0 1')!;
    expect(pos.dtz).toBeUndefined();
    // Capturing the pawn reaches KQvK, whose DTZ table is loaded.
    expect(pos.moves.filter((m) => m.dtz !== undefined).map((m) => m.uci)).toEqual(['b3c2']);
  });

  it('returns null or throws for what it cannot probe', () => {
    expect(core.probePosition('not a fen')).toBeNull();
    expect(core.probePosition('r3k3/8/8/8/8/8/8/4K3 b q - 0 1')).toBeNull(); // castling
    expect(core.probePosition('4k3/8/8/8/8/8/8/rnbqK3 w - - 0 1')).toBeNull(); // KvKRNBQ, missing
    expect(core.probePosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1')).toBeNull();
    expect(() => core.probeWdl('1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1')).toThrow(MissingTableError);
    expect(() => core.probeWdl('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1')).toThrow(
      TbBoardError,
    );
    try {
      core.probeWdl('1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1');
    } catch (e) {
      expect(e).toMatchObject({ table: 'KRPvKR', kind: 'wdl' });
    }
    expect(core.missing('KRPvKR')).toContain('KRPvKR.rtbw');
    expect(core.missing('KQvKP', 'dtz')).toEqual(['KQvKP.rtbz']);
  });

  it('is a TablebaseProbe usable by the opponent and the judge', async () => {
    const fen = '8/8/8/3k4/8/8/8/1KR5 b - - 0 1';
    const pos = (await core.probe(fen)) as TbPosition;
    expect(pos.category).toBe('loss');
    const reply = await opponentMove(pos, core, 'dtz');
    expect(keepers(pos).map((m) => m.uci)).toContain(reply);
    const win = core.probePosition('8/8/8/3k4/8/8/8/1KR5 w - - 0 1')!;
    const hang = judgeMove(win, 'c1c5')!; // the rook hangs next to the king
    expect(hang.kind).toBe('thrown');
  });

  it('probes a position with all children quickly', () => {
    const t0 = performance.now();
    for (const ref of coreRefs.slice(0, 200)) core.probePosition(ref.fen);
    expect((performance.now() - t0) / 200).toBeLessThan(50);
  }, 60_000);
});

describe('SyzygyTables.addTable', () => {
  const kqk = bytes(join(CORE_DIR, 'KQvK.rtbw'));

  it('rejects bad file names and non-table bytes', () => {
    const tb = new SyzygyTables();
    expect(() => tb.addTable('KvKQ.rtbw', kqk)).toThrow(/file name/);
    expect(() => tb.addTable('KQvK.bin', kqk)).toThrow(/file name/);
    expect(() => tb.addTable('../KQvK.rtbw', kqk)).toThrow(/file name/);
    expect(() => tb.addTable('KQvK.rtbw', kqk.subarray(0, 100))).toThrow(SyzygyFormatError);
    const wrongMagic = kqk.slice();
    wrongMagic[0] = 0;
    expect(() => tb.addTable('KQvK.rtbw', wrongMagic)).toThrow(SyzygyFormatError);
    // A WDL file offered as DTZ has the wrong magic.
    expect(() => tb.addTable('KQvK.rtbz', kqk)).toThrow(SyzygyFormatError);
  });

  it('reports what it holds', () => {
    const tb = new SyzygyTables();
    tb.addTable('KQvK.rtbw', kqk);
    expect(tb.has('KQvK', 'wdl')).toBe(true);
    expect(tb.has('KvKQ', 'wdl')).toBe(true);
    expect(tb.has('KQvK', 'dtz')).toBe(false);
    expect(tb.missing('KQvK')).toEqual([]);
    expect(tb.missing('KQvK', 'dtz')).toEqual(['KQvK.rtbz']);
    const pos = tb.probePosition('8/8/8/3k4/8/8/8/1KQ5 w - - 0 1')!;
    expect(pos.category).toBe('win');
    expect(pos.dtz).toBeUndefined();
    expect(pos.moves.every((m) => m.dtz === undefined)).toBe(true);
    expect(tb.probeDtz('8/8/8/3k4/8/8/8/1KQ5 w - - 0 1')).toBeNull();
  });
});

const CACHE = process.env.ENDGAME_CACHE_DIR || join(homedir(), '.cache', 'daisychess', 'endgames');
const slow = process.env.DAISYCHESS_SLOW_TESTS === '1';

describe.skipIf(!slow)('SyzygyTables on the rook pack (DAISYCHESS_SLOW_TESTS=1)', () => {
  it('matches the lichess API on the KRPvKR reference positions', () => {
    const rookFiles = MANIFEST.tables.filter((t) => t.pack === 'rook').map(tableFileName);
    const missing = rookFiles.filter((f) => !existsSync(join(CACHE, f)));
    expect(missing, `run fetch-tables.mjs --pack rook (cache ${CACHE})`).toEqual([]);
    const tb = new SyzygyTables();
    loadDir(tb, CORE_DIR);
    for (const t of MANIFEST.tables.filter((e) => e.pack === 'rook')) {
      const b = bytes(join(CACHE, tableFileName(t)));
      expect(sha256(b), tableFileName(t)).toBe(t.sha256);
      tb.addTable(tableFileName(t), b);
    }
    expect(tb.missing('KRPvKR')).toEqual([]);
    const refs = REFERENCE.positions.filter((p) => p.material === 'KRPvKR');
    expect(refs.length).toBeGreaterThanOrEqual(150);
    const diffs = refs.flatMap((ref) => compare(tb, ref));
    expect(diffs.slice(0, 20)).toEqual([]);
    // The fixture of M32-1 (Lucena-like win): every move's category.
    const lucena = tb.probePosition('1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1')!;
    expect(lucena.category).toBe('win');
    expect(lucena.dtz).toBeUndefined(); // WDL only
    // Self-consistency over the whole closure (decoding errors would break the negamax).
    const sign = (c: string): number =>
      c === 'win' || c === 'cursed-win' ? 1 : c === 'draw' ? 0 : -1;
    for (const [material, seed] of [
      ['KRPvKR', 21],
      ['KRBvKR', 22],
      ['KRNvKR', 23],
      ['KQRvKR', 24],
      ['KRRvKR', 25],
      ['KRvKP', 26],
    ] as const) {
      for (const fen of randomFens(material, 100, seed)) {
        const pos = tb.probePosition(fen);
        expect(pos, fen).not.toBeNull();
        if (!pos || pos.moves.length === 0) continue;
        expect(Math.max(...pos.moves.map((m) => -sign(m.category))) || 0, fen).toBe(
          sign(pos.category),
        );
      }
    }
  }, 60_000);
});
