#!/usr/bin/env node
// Verifies that the nginx vhost of the public site (deploy/nginx/daisychess.org.conf) serves exactly
// the Content-Security-Policy and security headers of apps/site/csp.config.mjs, which the site's
// Playwright tests run against (`vite preview` sends the same headers).
// Usage: node scripts/check-site-csp.mjs [extra nginx conf ...]   (e.g. the live site file)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SITE_CSP, SITE_SECURITY_HEADERS } from '../apps/site/csp.config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [`${root}deploy/nginx/daisychess.org.conf`, ...process.argv.slice(2)];

let failed = false;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  failed = true;
};

for (const file of files) {
  const conf = readFileSync(file, 'utf8');
  const before = failed;
  const m = /map\s+\$host\s+\$daisychess_site_csp\s*\{\s*default\s+"([^"]*)";\s*\}/.exec(conf);
  if (!m) fail(`${file}: no \`map $host $daisychess_site_csp { default "…"; }\` block`);
  else if (m[1] !== SITE_CSP) {
    fail(`${file}: CSP differs from apps/site/csp.config.mjs`);
    console.error(`  have:     ${m[1]}`);
    console.error(`  expected: default "${SITE_CSP}";`);
  }
  if (!/add_header\s+Content-Security-Policy\s+\$daisychess_site_csp\s+always;/.test(conf)) {
    fail(`${file}: missing \`add_header Content-Security-Policy $daisychess_site_csp always;\``);
  }
  for (const [name, value] of Object.entries(SITE_SECURITY_HEADERS)) {
    if (name === 'Content-Security-Policy') continue;
    const re = new RegExp(`add_header\\s+${name}\\s+"([^"]*)"\\s+always;`);
    const hm = re.exec(conf);
    if (!hm) fail(`${file}: missing \`add_header ${name} "${value}" always;\``);
    else if (hm[1] !== value) fail(`${file}: ${name} is "${hm[1]}", expected "${value}"`);
  }
  if (!/add_header\s+Strict-Transport-Security\s+"max-age=\d+[^"]*"\s+always;/.test(conf)) {
    fail(`${file}: missing HSTS header`);
  }
  // nginx drops inherited add_header directives in a location that declares its own.
  const locs = conf.split(/\n\s*location\s/).slice(1);
  for (const loc of locs) {
    const body = loc.slice(0, loc.indexOf('}'));
    if (/add_header/.test(body)) fail(`${file}: a location declares add_header and would lose the security headers`);
  }
  if (failed === before) console.log(`✓ ${file}`);
}
process.exit(failed ? 1 : 0);
