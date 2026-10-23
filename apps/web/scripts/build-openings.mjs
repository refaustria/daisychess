// Usage: node scripts/build-openings.mjs <dir containing a.tsv..e.tsv>
// Generates src/openings/data/openings.json: [eco, name, epd][]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: build-openings.mjs <tsv-dir>');
const out = join(dirname(fileURLToPath(import.meta.url)), '../src/openings/data/openings.json');
const rows = [];
const seen = new Set();
for (const f of ['a', 'b', 'c', 'd', 'e']) {
  const lines = readFileSync(join(dir, `${f}.tsv`), 'utf8')
    .split('\n')
    .slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [eco, name, pgn] = line.split('\t');
    const chess = new Chess();
    chess.loadPgn(pgn);
    const epd = chess.fen().split(' ').slice(0, 4).join(' ');
    // En passant square is only kept by chess.js when capturable, which keeps EPDs canonical.
    if (seen.has(epd)) continue;
    seen.add(epd);
    rows.push([eco, name, epd]);
  }
}
writeFileSync(out, JSON.stringify(rows));
console.log(`${rows.length} openings -> ${out}`);
