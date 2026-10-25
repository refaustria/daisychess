#!/usr/bin/env node
// Verifies that the nginx configs serve exactly the Content-Security-Policies built by
// apps/web/csp.config.mjs (app, which hashes the inline theme script in apps/web/index.html;
// legacy "moved" page; hub) and apps/portal/csp.config.mjs (portal).
//
// Production (ADR-021): the policies live once in deploy/nginx/daisychess-common.conf
// (conf.d); the vhosts only reference the variables. The check makes sure that
//   - every `map $host $<var> { default "…"; }` block anywhere carries the expected policy,
//   - daisychess-common.conf and docker/nginx.web.conf define the maps they must define,
//   - every vhost sends a Content-Security-Policy in every add_header group, only through the
//     variables it is allowed to use, and declares no map itself (nginx rejects duplicates).
//
// Usage: node scripts/check-csp.mjs [extra nginx conf ...]   (e.g. the live files)
// Extra files are checked for map values and for known variables. Prints the expected
// `default "...";` line on mismatch, ready to paste.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HUB_CSP, LEGACY_CSP, PRODUCTION_CSP } from '../apps/web/csp.config.mjs';
import { PORTAL_CSP } from '../apps/portal/csp.config.mjs';

export const EXPECTED = {
  daisychess_csp: PRODUCTION_CSP,
  daisychess_portal_csp: PORTAL_CSP,
  daisychess_legacy_csp: LEGACY_CSP,
  daisychess_hub_csp: HUB_CSP,
};

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Repo files and what they must contain. `maps`: variables the file must define; `uses`: the CSP
 * variables its add_header lines may reference (null = not a vhost, no reference check).
 */
export const REPO_FILES = [
  { file: 'deploy/nginx/daisychess-common.conf', maps: Object.keys(EXPECTED), uses: null },
  {
    file: 'deploy/nginx/play.daisychess.org.conf',
    maps: [],
    uses: ['daisychess_csp', 'daisychess_portal_csp'],
  },
  { file: 'deploy/nginx/hub.daisychess.org.conf', maps: [], uses: ['daisychess_hub_csp'] },
  {
    file: 'deploy/nginx/c.referee.at.conf',
    maps: [],
    uses: ['daisychess_legacy_csp', 'daisychess_csp'],
  },
  { file: 'docker/nginx.web.conf', maps: ['daisychess_csp'], uses: ['daisychess_csp'] },
];

const MAP_RE = /map\s+\$host\s+\$(\w+)\s*\{\s*default\s+"([^"]*)";\s*\}/g;
const CSP_HEADER_RE = /add_header\s+Content-Security-Policy\s+(\S+)/g;

/** Strips `#` comments (nginx has no quoted `#` in these files). */
const uncomment = (conf) => conf.replace(/#[^\n]*/g, '');

/**
 * add_header groups: the server level and every `location` block that declares add_header
 * directives of its own (nginx inheritance: such a block must repeat the CSP).
 * Returns the block texts with nested blocks removed, which is enough for these files.
 */
function headerGroups(conf) {
  const groups = [];
  const stack = [{ text: '', kind: 'top' }];
  let token = '';
  for (const ch of conf) {
    if (ch === '{') {
      stack.push({
        text: '',
        kind: /\blocation\b/.test(token)
          ? 'location'
          : /\bserver\s*$/.test(token.trim())
            ? 'server'
            : 'other',
      });
      token = '';
    } else if (ch === '}') {
      const done = stack.pop();
      if (done && (done.kind === 'location' || done.kind === 'server')) groups.push(done);
      token = '';
    } else {
      stack[stack.length - 1].text += ch;
      token = ch === ';' ? '' : token + ch;
    }
  }
  return groups.filter((g) => /\badd_header\b/.test(g.text));
}

/** Problems of one config text; `spec` as in {@link REPO_FILES}. Exported for the unit test. */
export function checkConf(name, rawConf, spec) {
  const errors = [];
  const ok = [];
  const conf = uncomment(rawConf);
  const maps = new Map([...conf.matchAll(MAP_RE)].map((m) => [m[1], m[2]]));
  for (const [v, value] of maps) {
    const expected = EXPECTED[v];
    if (expected === undefined) {
      if (v.includes('csp')) errors.push(`${name}: unknown CSP map $${v}`);
      continue;
    }
    if (value !== expected) {
      errors.push(
        `${name}: $${v} differs from its csp.config.mjs\n  have:     ${value}\n  expected: default "${expected}";`,
      );
    } else {
      ok.push(`${name} ($${v})`);
    }
  }
  for (const v of spec.maps ?? []) {
    if (!maps.has(v)) errors.push(`${name}: no \`map $host $${v} { default "…"; }\` block`);
  }
  if (spec.uses) {
    if (spec.maps?.length === 0 && maps.size > 0) {
      errors.push(
        `${name}: vhost declares map(s) ${[...maps.keys()].map((v) => `$${v}`).join(', ')}; they belong in daisychess-common.conf`,
      );
    }
    const groups = headerGroups(conf);
    if (groups.length === 0) errors.push(`${name}: no add_header at all`);
    for (const g of groups) {
      const refs = [...g.text.matchAll(CSP_HEADER_RE)].map((m) => m[1]);
      if (refs.length === 0) {
        errors.push(
          `${name}: an add_header block without Content-Security-Policy (inheritance drops the server-level one): ${g.text.trim().split('\n')[0]}`,
        );
      }
      for (const r of refs) {
        const v = r.startsWith('$') ? r.slice(1) : null;
        if (!v || !spec.uses.includes(v))
          errors.push(
            `${name}: Content-Security-Policy ${r} is not one of ${spec.uses.map((u) => `$${u}`).join(', ')}`,
          );
      }
    }
  } else if (spec.uses === undefined) {
    // Extra (live) files: every referenced CSP variable must be a known one.
    for (const m of conf.matchAll(CSP_HEADER_RE)) {
      const v = m[1].startsWith('$') ? m[1].slice(1) : null;
      if (!v || !(v in EXPECTED))
        errors.push(`${name}: Content-Security-Policy ${m[1]} is not a known policy variable`);
    }
  }
  return { errors, ok };
}

function main() {
  const targets = [
    ...REPO_FILES.map((s) => ({ ...s, path: `${root}${s.file}` })),
    ...process.argv
      .slice(2)
      .map((path) => ({ path, file: path, maps: undefined, uses: undefined })),
  ];
  let failed = false;
  for (const t of targets) {
    let conf;
    try {
      conf = readFileSync(t.path, 'utf8');
    } catch (e) {
      console.error(`✗ ${t.file}: ${e.message}`);
      failed = true;
      continue;
    }
    const { errors, ok } = checkConf(t.file, conf, t);
    for (const line of ok) console.log(`✓ ${line}`);
    for (const line of errors) console.error(`✗ ${line}`);
    if (errors.length === 0 && ok.length === 0) console.log(`✓ ${t.file} (CSP via variables only)`);
    failed ||= errors.length > 0;
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
