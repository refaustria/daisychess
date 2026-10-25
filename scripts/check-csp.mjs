#!/usr/bin/env node
// Verifies that the nginx configs serve exactly the Content-Security-Policy built by
// apps/web/csp.config.mjs (which hashes the inline theme script in apps/web/index.html).
// Usage: node scripts/check-csp.mjs [extra nginx conf ...]   (e.g. the live site file)
// Prints the expected `default "...";` line on mismatch, ready to paste.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_CSP } from '../apps/web/csp.config.mjs';
import { PORTAL_CSP } from '../apps/portal/csp.config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [
  `${root}deploy/nginx/c.referee.at.conf`,
  `${root}docker/nginx.web.conf`,
  ...process.argv.slice(2),
];

let failed = false;
for (const file of files) {
  const conf = readFileSync(file, 'utf8');
  const m = /map\s+\$host\s+\$daisychess_csp\s*\{\s*default\s+"([^"]*)";\s*\}/.exec(conf);
  if (!m) {
    console.error(`✗ ${file}: no \`map $host $daisychess_csp { default "…"; }\` block`);
    failed = true;
  } else if (m[1] !== PRODUCTION_CSP) {
    console.error(`✗ ${file}: CSP differs from apps/web/csp.config.mjs`);
    console.error(`  have:     ${m[1]}`);
    console.error(`  expected: default "${PRODUCTION_CSP}";`);
    failed = true;
  } else {
    console.log(`✓ ${file}`);
  }
  // The operator portal has its own policy (apps/portal/csp.config.mjs); only the site file carries it.
  if (file.endsWith('c.referee.at.conf')) {
    const pm = /map\s+\$host\s+\$daisychess_portal_csp\s*\{\s*default\s+"([^"]*)";\s*\}/.exec(conf);
    if (!pm) {
      console.error(`✗ ${file}: no \`map $host $daisychess_portal_csp { default "…"; }\` block`);
      failed = true;
    } else if (pm[1] !== PORTAL_CSP) {
      console.error(`✗ ${file}: portal CSP differs from apps/portal/csp.config.mjs`);
      console.error(`  have:     ${pm[1]}`);
      console.error(`  expected: default "${PORTAL_CSP}";`);
      failed = true;
    } else {
      console.log(`✓ ${file} (portal)`);
    }
  }
}
process.exit(failed ? 1 : 0);
