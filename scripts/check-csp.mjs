#!/usr/bin/env node
// Verifies that the nginx configs serve exactly the Content-Security-Policy built by
// apps/web/csp.config.mjs (which hashes the inline theme script in apps/web/index.html).
// Usage: node scripts/check-csp.mjs [extra nginx conf ...]   (e.g. the live site file)
// Prints the expected `default "...";` line on mismatch, ready to paste.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_CSP } from '../apps/web/csp.config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [
  `${root}deploy/nginx/c.referee.at.conf`,
  `${root}docker/nginx.web.conf`,
  ...process.argv.slice(2),
];

let failed = false;
for (const file of files) {
  const conf = readFileSync(file, 'utf8');
  const m = /map\s+\$host\s+\$chesslab_csp\s*\{\s*default\s+"([^"]*)";\s*\}/.exec(conf);
  if (!m) {
    console.error(`✗ ${file}: no \`map $host $chesslab_csp { default "…"; }\` block`);
    failed = true;
  } else if (m[1] !== PRODUCTION_CSP) {
    console.error(`✗ ${file}: CSP differs from apps/web/csp.config.mjs`);
    console.error(`  have:     ${m[1]}`);
    console.error(`  expected: default "${PRODUCTION_CSP}";`);
    failed = true;
  } else {
    console.log(`✓ ${file}`);
  }
}
process.exit(failed ? 1 : 0);
