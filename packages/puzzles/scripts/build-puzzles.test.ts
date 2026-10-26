// Pipeline (M30-2): build-puzzles.mjs end to end on the committed 300-row fixture, the stream
// reader (plain, zstd via zlib and via the CLI, truncated samples), and deploy/deploy-puzzles.sh
// with file:// URLs (download, sha256 verification, cache hit, pin, publish, prune).
// Needs the built package (`pnpm build` runs before `pnpm test` in CI).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PuzzleIndexSchema, ShardSchema, StarterSchema } from '../src/schemas.js';
import { STARTER_MAX_BYTES } from '../src/curation.js';
import {
  buildPuzzles,
  illegalRows,
  parseArgs,
  streamLines,
  type BuildOptions,
} from './build-puzzles.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const fixture = join(here, '../test/fixtures/puzzles-sample.csv');
const script = join(here, 'build-puzzles.mjs');
const deployScript = join(repo, 'deploy/deploy-puzzles.sh');
const fixtureText = readFileSync(fixture, 'utf8');
const fixtureLines = fixtureText.split('\n').filter((l) => l.length > 0);

const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const hasZstdCli = has('zstd');
// zstd in zlib: Node ≥ 22.15 (the @types/node pin predates it).
const zstdZlib = zlib as typeof zlib & { zstdCompressSync?: (b: Buffer) => Buffer };
const hasZlibZstd = typeof zstdZlib.zstdCompressSync === 'function';
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Frame by frame (4 kB each), like a large dump: a truncated file still decodes its head. */
function zstd(data: Buffer): Buffer {
  const frames: Buffer[] = [];
  for (let i = 0; i < data.length; i += 4096) {
    const part = data.subarray(i, i + 4096);
    frames.push(
      zstdZlib.zstdCompressSync
        ? zstdZlib.zstdCompressSync(part)
        : execFileSync('zstd', ['-c', '-q'], { input: part }),
    );
  }
  return Buffer.concat(frames);
}

let tmp = '';
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'build-puzzles-test-'));
  if (!existsSync(join(here, '../dist/index.js'))) {
    throw new Error('packages/puzzles/dist missing: run `pnpm --filter @daisychess/puzzles build`');
  }
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const opts = (o: Partial<BuildOptions>): BuildOptions => ({
  input: fixture,
  dryRun: false,
  zstdCli: false,
  builtAt: '2026-10-26T00:00:00.000Z',
  lastModified: 'Fri, 02 Oct 2026 00:00:00 GMT',
  ...o,
});
const quiet = () => {};

describe('parseArgs', () => {
  it('reads every flag', () => {
    expect(
      parseArgs([
        '--input',
        'a.zst',
        '--out',
        'o',
        '--starter',
        's.json',
        '--sample',
        '1000',
        '--jobs',
        '3',
        '--source',
        'https://x/y.zst',
        '--last-modified',
        'Fri, 02 Oct 2026 00:00:00 GMT',
        '--built-at',
        '2026-10-26T00:00:00Z',
        '--zstd-cli',
      ]),
    ).toEqual({
      input: 'a.zst',
      out: 'o',
      starter: 's.json',
      sample: 1000,
      jobs: 3,
      source: 'https://x/y.zst',
      lastModified: 'Fri, 02 Oct 2026 00:00:00 GMT',
      builtAt: '2026-10-26T00:00:00Z',
      dryRun: false,
      zstdCli: true,
    });
    expect(parseArgs(['--input', 'a', '--dry-run']).dryRun).toBe(true);
    expect(parseArgs(['--input', 'a', '--out', 'o', '--sha256', 'AB'.repeat(32)]).sha256).toBe(
      'ab'.repeat(32),
    );
  });

  it('refuses missing or malformed values', () => {
    expect(() => parseArgs([])).toThrow(/--input is required/);
    expect(() => parseArgs(['--input', 'a'])).toThrow(/--out is required/);
    expect(() => parseArgs(['--input', '--out', 'o'])).toThrow(/--input needs a value/);
    expect(() => parseArgs(['--input', 'a', '--out', 'o', '--sample', '0'])).toThrow(/--sample/);
    expect(() => parseArgs(['--input', 'a', '--out', 'o', '--sha256', 'abc'])).toThrow(/64 hex/);
    expect(() => parseArgs(['--input', 'a', '--out', 'o', '--jobs', '0'])).toThrow(/--jobs/);
    expect(() => parseArgs(['--input', 'a', '--out', 'o', '--bogus'])).toThrow(/unknown argument/);
    expect(() =>
      parseArgs(['--input', 'a', '--out', 'o', '--sample', '10', '--sha256', 'a'.repeat(64)]),
    ).toThrow(/cannot verify a --sample/);
  });
});

describe('streamLines', () => {
  const collect = async (path: string, o: { sample?: number; zstdCli?: boolean } = {}) => {
    const lines: string[] = [];
    const r = await streamLines(path, o, (l) => lines.push(l));
    return { lines, ...r };
  };

  it('splits a plain CSV, drops \\r and keeps a last line without a newline', async () => {
    const p = join(tmp, 'crlf.csv');
    writeFileSync(p, 'a,b\r\nc,d\r\ne,f');
    expect(await collect(p)).toEqual({
      lines: ['a,b', 'c,d', 'e,f'],
      bytes: statSync(p).size,
      partial: false,
    });
  });

  it('a plain sample drops the cut last line', async () => {
    const p = join(tmp, 'cut.csv');
    writeFileSync(p, 'header\nrow1,x\nrow2,yyyy\n');
    const r = await collect(p, { sample: 'header\nrow1,x\nrow2,y'.length });
    expect(r.lines).toEqual(['header', 'row1,x']);
    expect(r.partial).toBe(true);
    // A sample larger than the file is a full read.
    expect((await collect(p, { sample: 1e9 })).lines).toHaveLength(3);
  });

  const zstPath = () => {
    const p = join(tmp, 'fixture.csv.zst');
    if (!existsSync(p)) writeFileSync(p, zstd(Buffer.from(fixtureText)));
    return p;
  };

  it.runIf(hasZlibZstd || hasZstdCli)('decompresses zstd with zlib (or the CLI)', async () => {
    const r = await collect(zstPath());
    expect(r.lines).toEqual(fixtureLines);
    expect(r.partial).toBe(false);
  });

  it.runIf(hasZstdCli)('decompresses zstd with the zstd CLI fallback', async () => {
    const r = await collect(zstPath(), { zstdCli: true });
    expect(r.lines).toEqual(fixtureLines);
  });

  it.runIf(hasZstdCli)('reads a zstd stream that starts with a skippable frame', async () => {
    const skippable = Buffer.concat([
      Buffer.from([0x50, 0x2a, 0x4d, 0x18, 4, 0, 0, 0, 1, 2, 3, 4]),
      zstd(Buffer.from(fixtureText)),
    ]);
    const p = join(tmp, 'skippable.csv.zst');
    writeFileSync(p, skippable);
    expect((await collect(p)).lines).toEqual(fixtureLines);
  });

  for (const cli of [false, true]) {
    it.runIf(cli ? hasZstdCli : hasZlibZstd || hasZstdCli)(
      `a truncated zstd file fails without --sample and is tolerated with it (${cli ? 'CLI' : 'zlib'})`,
      async () => {
        const p = zstPath();
        const half = Math.floor(statSync(p).size / 2);
        const cut = join(tmp, `cut-${cli}.csv.zst`);
        writeFileSync(cut, readFileSync(p).subarray(0, half));
        await expect(collect(cut, { zstdCli: cli })).rejects.toThrow();
        const r = await collect(p, { sample: half, zstdCli: cli });
        expect(r.partial).toBe(true);
        expect(r.bytes).toBe(half);
        // Every emitted line is a complete fixture line, in order; the cut one is dropped.
        expect(r.lines.length).toBeGreaterThan(10);
        expect(r.lines.length).toBeLessThan(fixtureLines.length);
        expect(r.lines).toEqual(fixtureLines.slice(0, r.lines.length));
      },
    );
  }

  it('an error thrown by the line callback propagates, also in sample mode', async () => {
    await expect(
      streamLines(fixture, { sample: 5000 }, () => {
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
  });
});

describe('illegalRows', () => {
  const legal = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves: ['e2e4', 'e7e5'],
  };
  const bad = { ...legal, moves: ['e2e5', 'e7e5'] };

  it('finds illegal lines inline', async () => {
    expect([...(await illegalRows([legal, bad, legal], 1))]).toEqual([1]);
  });

  it('finds illegal lines in worker threads (offsets preserved)', async () => {
    const rows = Array.from({ length: 4100 }, (_, i) => (i === 7 || i === 4099 ? bad : legal));
    expect([...(await illegalRows(rows, 3))].sort((a, b) => a - b)).toEqual([7, 4099]);
  }, 60_000);
});

function readOut(out: string) {
  const index = PuzzleIndexSchema.parse(JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')));
  const files = readdirSync(join(out, 'shards')).sort();
  return { index, files };
}

describe('buildPuzzles on the fixture', () => {
  it('writes content-addressed shards, an index naming exactly them, the starter and SOURCE.md', async () => {
    const out = join(tmp, 'out1');
    const starter = join(tmp, 'starter1', 'starter.json');
    const s = await buildPuzzles(opts({ out, starter }), quiet);

    expect(s.rows).toBe(300);
    expect(s.hardFiltered).toBe(191);
    expect(s.curated).toBe(191);
    expect(s.rejects).toEqual({ filtered: 109 });
    expect(s.sha256).toBe(sha256(readFileSync(fixture)));
    expect(Object.values(s.perBand).reduce((a, b) => a + b, 0)).toBe(191);
    expect(s.maxRssMb).toBeGreaterThan(0);

    const { index, files } = readOut(out);
    expect(index.dataset).toEqual({
      source: 'https://database.lichess.org/lichess_db_puzzle.csv.zst',
      sha256: s.sha256,
      lastModified: 'Fri, 02 Oct 2026 00:00:00 GMT',
      builtAt: '2026-10-26T00:00:00.000Z',
      total: 191,
    });
    expect(index.shards.map((e) => e.file.slice('shards/'.length)).sort()).toEqual(files);
    const ids = new Set<string>();
    for (const e of index.shards) {
      const raw = readFileSync(join(out, e.file));
      expect(e.file).toBe(`shards/${e.band}-${sha256(raw).slice(0, 16)}.json`);
      expect(e.bytes).toBe(raw.length);
      const shard = ShardSchema.parse(JSON.parse(raw.toString()));
      expect(shard.dataset).toBe(s.sha256);
      expect(shard.band).toBe(e.band);
      expect(shard.rows).toHaveLength(e.count);
      for (const r of shard.rows) {
        expect(Math.min(2900, Math.max(500, Math.floor(r[3] / 100) * 100))).toBe(e.band);
        ids.add(r[0]);
      }
    }
    expect(ids.size).toBe(191);

    const starterRaw = readFileSync(starter);
    expect(starterRaw.length).toBe(s.starter.bytes);
    expect(starterRaw.length).toBeLessThanOrEqual(STARTER_MAX_BYTES);
    const st = StarterSchema.parse(JSON.parse(starterRaw.toString()));
    expect(st.dataset).toBe(s.sha256);
    expect(st.rows.length).toBe(s.starter.rows);
    expect(st.daily.every((i) => i >= 0 && i < st.rows.length)).toBe(true);
    const md = readFileSync(join(dirname(starter), 'SOURCE.md'), 'utf8');
    expect(md).toContain(s.sha256);
    expect(md).toContain('CC0');
    expect(md).not.toContain('Sample build');
  });

  it('is deterministic: the same input gives the same shard names and starter', async () => {
    const a = await buildPuzzles(
      opts({ out: join(tmp, 'det-a'), starter: join(tmp, 'det-a/s.json') }),
      quiet,
    );
    const b = await buildPuzzles(
      opts({ out: join(tmp, 'det-b'), starter: join(tmp, 'det-b/s.json') }),
      quiet,
    );
    expect(b.shards).toEqual(a.shards);
    expect(readFileSync(join(tmp, 'det-b/s.json'))).toEqual(
      readFileSync(join(tmp, 'det-a/s.json')),
    );
  });

  it('--dry-run writes nothing', async () => {
    const out = join(tmp, 'dry');
    const s = await buildPuzzles(opts({ out, starter: join(out, 's.json'), dryRun: true }), quiet);
    expect(s.curated).toBe(191);
    expect(existsSync(out)).toBe(false);
  });

  it('fails closed on a wrong --sha256 before writing anything', async () => {
    const out = join(tmp, 'badsum');
    await expect(buildPuzzles(opts({ out, sha256: 'f'.repeat(64) }), quiet)).rejects.toThrow(
      /sha256 mismatch/,
    );
    expect(existsSync(out)).toBe(false);
    const ok = await buildPuzzles(opts({ out, sha256: sha256(readFileSync(fixture)) }), quiet);
    expect(ok.curated).toBe(191);
  });

  it('refuses an unexpected header (format change)', async () => {
    const p = join(tmp, 'header.csv');
    writeFileSync(p, fixtureText.replace('PuzzleId,FEN', 'Id,FEN'));
    await expect(buildPuzzles(opts({ input: p, dryRun: true }), quiet)).rejects.toThrow(
      /unexpected header/,
    );
  });

  it('drops illegal rows found in the selection and selects again', async () => {
    // Corrupt the first move of three selected rows: still well-formed UCI, but illegal.
    const victims = new Set<string>();
    const corrupted = fixtureLines.map((l, i) => {
      if (i === 0) return l;
      const f = l.split(',');
      if (victims.size < 3 && Number(f[5]) >= 90 && Number(f[4]) <= 80 && Number(f[6]) >= 300) {
        victims.add(f[0]!);
        f[2] = ['a1a1', ...f[2]!.split(' ').slice(1)].join(' ');
      }
      return f.join(',');
    });
    const p = join(tmp, 'illegal.csv');
    writeFileSync(p, corrupted.join('\n') + '\n');
    const out = join(tmp, 'illegal-out');
    const s = await buildPuzzles(opts({ input: p, out }), quiet);
    expect(s.rejects).toEqual({ filtered: 109, illegal: 3 });
    expect(s.hardFiltered).toBe(191);
    expect(s.curated).toBe(188);
    const { index } = readOut(out);
    expect(index.dataset.total).toBe(188);
    for (const e of index.shards) {
      const rows = ShardSchema.parse(JSON.parse(readFileSync(join(out, e.file), 'utf8'))).rows;
      for (const r of rows) expect(victims.has(r[0])).toBe(false);
    }
  });

  it('builds from a truncated zstd sample (the ranged download of the real dump)', async () => {
    const zst = zstd(Buffer.from(fixtureText));
    const p = join(tmp, 'sample.csv.zst');
    writeFileSync(p, zst);
    const sample = Math.floor(zst.length * 0.6);
    const starter = join(tmp, 'sample-out/starter.json');
    const s = await buildPuzzles(
      opts({ input: p, sample, out: join(tmp, 'sample-out'), starter }),
      quiet,
    );
    expect(s.partial).toBe(true);
    expect(s.bytes).toBe(sample);
    expect(s.sha256).toBe(sha256(zst.subarray(0, sample)));
    expect(s.rows).toBeGreaterThan(50);
    expect(s.rows).toBeLessThan(300);
    expect(readFileSync(join(tmp, 'sample-out/SOURCE.md'), 'utf8')).toContain('Sample build');
  });

  it('the CLI exits 2 on usage errors and 1 on failures', () => {
    expect(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status).toBe(2);
    const r = spawnSync(
      process.execPath,
      [script, '--input', fixture, '--dry-run', '--sha256', '0'.repeat(64)],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/sha256 mismatch/);
    const ok = spawnSync(process.execPath, [script, '--input', fixture, '--dry-run'], {
      encoding: 'utf8',
    });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/rows 300, hard filter 191, curated 191/);
    expect(ok.stdout).toMatch(/per theme/);
  });
});

const deployTools = ['bash', 'curl', 'rsync', 'sha256sum', 'pnpm'].every(has);

describe.runIf(deployTools && (hasZlibZstd || hasZstdCli))('deploy/deploy-puzzles.sh', () => {
  let base = '';
  let env: Record<string, string> = {};
  let dump = '';

  const run = (args: string[] = [], extra: Record<string, string> = {}) =>
    spawnSync('bash', [deployScript, '--no-install', ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env, ...extra },
      timeout: 120_000,
    });
  const sums = (digest: string) =>
    writeFileSync(
      join(base, 'remote/sha256sums.txt'),
      `${'0'.repeat(64)}  lichess_db_puzzle.csv.zst.other\n${digest}  lichess_db_puzzle.csv.zst\n`,
    );

  beforeAll(() => {
    base = join(tmp, 'deploy');
    mkdirSync(join(base, 'remote'), { recursive: true });
    dump = join(base, 'remote/lichess_db_puzzle.csv.zst');
    const zst = zstd(Buffer.from(fixtureText));
    writeFileSync(dump, zst);
    sums(sha256(zst));
    env = {
      PUZZLE_CACHE_DIR: join(base, 'cache'),
      PUZZLE_ROOT: join(base, 'www/puzzles/v1'),
      PUZZLE_STARTER: join(base, 'repo-data/starter.json'),
      LICHESS_PUZZLE_URL: `file://${dump}`,
      LICHESS_SUMS_URL: `file://${join(base, 'remote/sha256sums.txt')}`,
      // The package was built before the tests; rebuilding dist here would race other test files.
      PUZZLES_SKIP_BUILD: '1',
    };
  });

  it('downloads, verifies, publishes shards + index and writes the starter', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Downloading/);
    expect(r.stdout).toMatch(/Next steps/);
    const { index, files } = readOut(env.PUZZLE_ROOT!);
    expect(index.dataset.sha256).toBe(sha256(readFileSync(dump)));
    expect(index.dataset.source).toBe(env.LICHESS_PUZZLE_URL);
    expect(index.shards).toHaveLength(files.length);
    expect(existsSync(env.PUZZLE_STARTER!)).toBe(true);
    expect(existsSync(join(dirname(env.PUZZLE_STARTER!), 'SOURCE.md'))).toBe(true);
    expect(
      readFileSync(join(env.PUZZLE_CACHE_DIR!, 'lichess_db_puzzle.csv.zst.sha256'), 'utf8').trim(),
    ).toBe(index.dataset.sha256);
  }, 120_000);

  it('uses the cache when the listed digest is unchanged (no download)', () => {
    // Same file name, but the URL points nowhere: only the cached, re-verified dump can pass.
    const ok = run([], {
      LICHESS_PUZZLE_URL: `file://${join(base, 'gone/lichess_db_puzzle.csv.zst')}`,
    });
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/Cached dump is current/);
    expect(ok.stdout).not.toMatch(/Downloading/);
  }, 120_000);

  it('fails closed on a digest mismatch and on a pin mismatch, publishing nothing', () => {
    const before = readFileSync(join(env.PUZZLE_ROOT!, 'index.json'));
    sums('a'.repeat(64));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/expected a{64}/);
    expect(existsSync(join(env.PUZZLE_CACHE_DIR!, 'lichess_db_puzzle.csv.zst.part'))).toBe(false);
    sums(sha256(readFileSync(dump)));
    const pinned = run([], { LICHESS_PUZZLE_SHA256: 'b'.repeat(64) });
    expect(pinned.status).toBe(1);
    expect(pinned.stderr).toMatch(/LICHESS_PUZZLE_SHA256/);
    expect(readFileSync(join(env.PUZZLE_ROOT!, 'index.json'))).toEqual(before);
  }, 120_000);

  it('detects a tampered cache file', () => {
    const cached = join(env.PUZZLE_CACHE_DIR!, 'lichess_db_puzzle.csv.zst');
    const good = readFileSync(cached);
    writeFileSync(cached, Buffer.concat([good, Buffer.from('x')]));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/marked stale/);
    // The next run downloads again and succeeds.
    rmSync(cached);
    const ok = run();
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/Downloading/);
  }, 120_000);

  it('resumes a partial download of the same dump', () => {
    rmSync(join(env.PUZZLE_CACHE_DIR!, 'lichess_db_puzzle.csv.zst'));
    rmSync(join(env.PUZZLE_CACHE_DIR!, 'lichess_db_puzzle.csv.zst.sha256'));
    const full = readFileSync(dump);
    const part = join(env.PUZZLE_CACHE_DIR!, 'lichess_db_puzzle.csv.zst.part');
    writeFileSync(part, full.subarray(0, 1000));
    writeFileSync(`${part}.sha256`, `${sha256(full)}\n`);
    const r = run();
    expect(r.status).toBe(0);
    expect(readFileSync(join(env.PUZZLE_CACHE_DIR!, 'lichess_db_puzzle.csv.zst'))).toEqual(full);
  }, 120_000);

  it('prunes unreferenced shards only after the grace period, never referenced ones', () => {
    const shards = join(env.PUZZLE_ROOT!, 'shards');
    writeFileSync(join(shards, '1500-00000000000000aa.json'), '{}');
    writeFileSync(join(shards, '1500-00000000000000bb.json'), '{}');
    const state = join(env.PUZZLE_CACHE_DIR!, 'unreferenced.txt');
    const old = Math.floor(Date.now() / 1000) - 31 * 86400;
    writeFileSync(state, `1500-00000000000000aa.json ${old}\n`);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/pruned: 1/);
    expect(existsSync(join(shards, '1500-00000000000000aa.json'))).toBe(false);
    expect(existsSync(join(shards, '1500-00000000000000bb.json'))).toBe(true);
    expect(readFileSync(state, 'utf8')).toMatch(/^1500-00000000000000bb\.json \d+\n$/);
    const { index, files } = readOut(env.PUZZLE_ROOT!);
    for (const e of index.shards) expect(files).toContain(e.file.slice('shards/'.length));
  }, 120_000);

  it('--dry-run publishes nothing; --sample builds the starter from a ranged download only', () => {
    const before = readFileSync(join(env.PUZZLE_ROOT!, 'index.json'));
    const dry = run(['--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/Dry run/);
    const starter = join(base, 'sample-data/starter.json');
    const sample = run(['--sample', String(Math.floor(statSync(dump).size * 0.6))], {
      PUZZLE_STARTER: starter,
    });
    expect(sample.status).toBe(0);
    expect(sample.stdout).toMatch(/not published/);
    expect(readFileSync(join(dirname(starter), 'SOURCE.md'), 'utf8')).toContain('Sample build');
    expect(readFileSync(join(env.PUZZLE_ROOT!, 'index.json'))).toEqual(before);
  }, 120_000);
});
