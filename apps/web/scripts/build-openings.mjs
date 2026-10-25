// Usage: node scripts/build-openings.mjs <dir containing a.tsv..e.tsv>
// Generates src/openings/data/openings.json: [eco, name, epd, moves][]
// `moves` is the line as space-separated SAN without move numbers ("e4 e5 Nf3 Nc6").
// The TSVs are third-party data: every row is validated (ECO code, name length, legal PGN).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: build-openings.mjs <tsv-dir>');
const out = join(dirname(fileURLToPath(import.meta.url)), '../src/openings/data/openings.json');
const ECO = /^[A-E]\d\d$/;
const rows = [];
const seen = new Set();
let skipped = 0;
for (const f of ['a', 'b', 'c', 'd', 'e']) {
  const lines = readFileSync(join(dir, `${f}.tsv`), 'utf8')
    .split('\n')
    .slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [eco, name, pgn] = line.split('\t');
    if (!ECO.test(eco ?? '') || !name || name.length > 200 || !pgn) {
      skipped++;
      continue;
    }
    const chess = new Chess();
    try {
      chess.loadPgn(pgn);
    } catch {
      skipped++;
      continue;
    }
    const moves = chess.history();
    if (moves.length === 0) {
      skipped++;
      continue;
    }
    const epd = chess.fen().split(' ').slice(0, 4).join(' ');
    // En passant square is only kept by chess.js when capturable, which keeps EPDs canonical.
    if (seen.has(epd)) continue;
    seen.add(epd);
    rows.push([eco, name.trim(), epd, moves.join(' ')]);
  }
}
// One row per line: small diffs on regeneration, and still valid JSON.
writeFileSync(out, `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`);
console.log(
  `${rows.length} openings -> ${out}${skipped ? ` (${skipped} invalid rows skipped)` : ''}`,
);
