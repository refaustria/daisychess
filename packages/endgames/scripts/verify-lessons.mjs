#!/usr/bin/env node
// Verifies the start positions of the endgame course (ADR-025 §6) against the lichess tablebase
// and writes the committed verdicts next to the lesson data.
//
//   node packages/endgames/scripts/verify-lessons.mjs [--out <file>] [--cache <file>]
//        [--delay <ms>] [--check]
//
// Reads apps/web/src/endgames/data/lessons.ts (Node's built-in type stripping: Node >= 22.18 or 24;
// the file has no runtime imports), validates every lesson with the BUILT package
// (`pnpm --filter @daisychess/endgames build` first), queries
// https://tablebase.lichess.ovh/standard?fen=… once per start position (>= 300 ms apart,
// Retry-After honoured, results cached in --cache) and writes lessons.verdicts.json:
//   { source, fetchedAt, verdicts: { [id]: { fen, category, dtm, dtz, moves, keepers } } }
// `keepers` counts the user's moves that keep the lesson's result (win: still winning; draw:
// still at least a draw). It is a tool for the author: run once after editing a start position,
// commit the output. CI and the tests never call the API.
//
// Checks (exit 1 on any failure): win lessons start as `win` with a known dtm and
// budget >= ceil(|dtm| / 2) + 4 (dtm is in plies); draw lessons start as `draw`.
// --check  verifies but writes nothing. Exit codes: 0 ok, 1 failed check or API error, 2 usage.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = 'https://tablebase.lichess.ovh/standard';
const here = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(here, '../../../apps/web/src/endgames/data');

function parseArgs(argv) {
  const opts = {
    out: join(dataDir, 'lessons.verdicts.json'),
    cache: join(tmpdir(), 'daisychess-lesson-verdicts-cache.json'),
    delay: 350,
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--cache') opts.cache = argv[++i];
    else if (a === '--delay') opts.delay = Number(argv[++i]);
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!opts.out || !opts.cache || !(opts.delay >= 300)) {
    console.error('usage: verify-lessons.mjs [--out f] [--cache f] [--delay ms>=300] [--check]');
    process.exit(2);
  }
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadCache(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  } catch {
    return {};
  }
}

async function query(fen, opts, cache, state) {
  if (cache[fen]) return cache[fen];
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = state.last + opts.delay - Date.now();
    if (wait > 0) await sleep(wait);
    state.last = Date.now();
    const res = await fetch(`${API}?fen=${encodeURIComponent(fen)}`, {
      headers: { accept: 'application/json', 'user-agent': 'daisychess-verify-lessons' },
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after')) || 5;
      await sleep(retry * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${fen}: ${await res.text()}`);
    const json = await res.json();
    cache[fen] = json;
    writeFileSync(opts.cache, JSON.stringify(cache));
    return json;
  }
  throw new Error(`rate limited for ${fen}`);
}

function keepersOf(lesson, moves) {
  // A move's `category` is from the opponent's point of view after the move.
  const keeps =
    lesson.goal === 'win'
      ? (c) => c === 'loss'
      : (c) => c === 'draw' || c === 'loss';
  return moves.filter((m) => keeps(m.category)).length;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { LessonSchema } = await import(pathToFileURL(join(here, '../dist/index.js')).href);
  const { LESSONS } = await import(pathToFileURL(join(dataDir, 'lessons.ts')).href);

  const cache = loadCache(opts.cache);
  const state = { last: 0 };
  const verdicts = {};
  const failures = [];
  const seen = new Set();

  for (const lesson of LESSONS) {
    const parsed = LessonSchema.safeParse(lesson);
    if (!parsed.success) {
      failures.push(`${lesson.id}: schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (seen.has(lesson.id)) failures.push(`${lesson.id}: duplicate id`);
    seen.add(lesson.id);

    const tb = await query(lesson.fen, opts, cache, state);
    const expected = lesson.goal === 'win' ? 'win' : 'draw';
    const verdict = {
      fen: lesson.fen,
      category: tb.category,
      dtm: tb.dtm ?? null,
      dtz: tb.dtz ?? null,
      moves: tb.moves.length,
      keepers: keepersOf(lesson, tb.moves),
    };
    verdicts[lesson.id] = verdict;

    if (tb.category !== expected) {
      failures.push(`${lesson.id}: start is ${tb.category}, the goal ${lesson.goal} needs ${expected}`);
    } else if (lesson.goal === 'win') {
      if (verdict.dtm === null) failures.push(`${lesson.id}: no dtm for the start position`);
      else {
        const need = Math.ceil(Math.abs(verdict.dtm) / 2) + 4;
        if (lesson.budget < need) {
          failures.push(`${lesson.id}: budget ${lesson.budget} < ceil(${verdict.dtm}/2) + 4 = ${need}`);
        }
      }
    }
    const dtmText = verdict.dtm === null ? '-' : String(verdict.dtm);
    console.log(
      `${lesson.id.padEnd(20)} ${tb.category.padEnd(6)} dtm ${dtmText.padStart(3)} ` +
        `budget ${String(lesson.budget).padStart(2)}  keepers ${verdict.keepers}/${verdict.moves}`,
    );
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  if (opts.check) {
    console.log('ok (nothing written)');
    return;
  }
  const out = {
    source: 'lichess tablebase API, https://tablebase.lichess.ovh/standard',
    fetchedAt: new Date().toISOString().slice(0, 10),
    verdicts,
  };
  writeFileSync(opts.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${opts.out} (${Object.keys(verdicts).length} verdicts)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
