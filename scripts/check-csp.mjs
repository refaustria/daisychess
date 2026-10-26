#!/usr/bin/env node
// Verifies that the nginx configs serve exactly the Content-Security-Policies built by
// apps/web/csp.config.mjs (app, which hashes the inline theme script in apps/web/index.html;
// hub) and apps/portal/csp.config.mjs (portal).
//
// Production (ADR-021): the policies live once in deploy/nginx/daisychess-common.conf
// (conf.d); the vhosts only reference the variables. The check makes sure that
//   - every `map $host $<var> { default "…"; }` block anywhere carries the expected policy,
//   - daisychess-common.conf and docker/nginx.web.conf define the maps they must define,
//   - every vhost sends a Content-Security-Policy in every add_header group, only through the
//     variables it is allowed to use, and declares no map itself (nginx rejects duplicates).
//
// Puzzle data (ADR-023 §5) is checked here too, because its locations are add_header groups of
// the app vhost: `location /puzzles/v1/shards/` (immutable) and `location = /puzzles/v1/index.json`
// (1 h) must carry the full header group with CORP `cross-origin`, `Access-Control-Allow-Origin
// $daisychess_app_cors` and `Vary: Origin`; no other location may send that CORS header or relax
// CORP; the map `$daisychess_app_cors` (daisychess-common.conf) must echo exactly
// MOBILE_APP_ORIGINS of apps/web/csp.config.mjs and default to "".
//
// Usage: node scripts/check-csp.mjs [extra nginx conf ...]   (e.g. the live files)
// Extra files are checked for map values and for known variables. Prints the expected
// `default "...";` line on mismatch, ready to paste.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HUB_CSP, MOBILE_APP_ORIGINS, PRODUCTION_CSP } from '../apps/web/csp.config.mjs';
import { PORTAL_CSP } from '../apps/portal/csp.config.mjs';

export const EXPECTED = {
  daisychess_csp: PRODUCTION_CSP,
  daisychess_portal_csp: PORTAL_CSP,
  daisychess_hub_csp: HUB_CSP,
};

/** CORS map of the puzzle data: echoes exactly these origins (ADR-022 §4 app WebViews). */
export const APP_CORS_VAR = 'daisychess_app_cors';
export const EXPECTED_CORS_ORIGINS = MOBILE_APP_ORIGINS;

/** The puzzle locations of the app vhost and the Cache-Control each must send. */
export const PUZZLE_LOCATIONS = {
  '/puzzles/v1/shards/': 'public, max-age=31536000, immutable',
  '= /puzzles/v1/index.json': 'public, max-age=3600',
};

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Repo files and what they must contain. `maps`: variables the file must define; `uses`: the CSP
 * variables its add_header lines may reference (null = not a vhost, no reference check).
 */
export const REPO_FILES = [
  {
    file: 'deploy/nginx/daisychess-common.conf',
    maps: Object.keys(EXPECTED),
    uses: null,
    corsMap: true,
  },
  {
    file: 'deploy/nginx/play.daisychess.org.conf',
    maps: [],
    uses: ['daisychess_csp', 'daisychess_portal_csp'],
    puzzles: true,
  },
  { file: 'deploy/nginx/hub.daisychess.org.conf', maps: [], uses: ['daisychess_hub_csp'] },
  { file: 'docker/nginx.web.conf', maps: ['daisychess_csp'], uses: ['daisychess_csp'] },
];

const MAP_RE = /map\s+\$host\s+\$(\w+)\s*\{\s*default\s+"([^"]*)";\s*\}/g;
const CSP_HEADER_RE = /add_header\s+Content-Security-Policy\s+(\S+)/g;
const ANY_MAP_RE = /map\s+\$\w+\s+\$(\w+)\s*\{([^}]*)\}/g;
const CORS_MAP_RE = /map\s+\$http_origin\s+\$daisychess_app_cors\s*\{([^}]*)\}/g;

/** Strips `#` comments (nginx has no quoted `#` in these files). */
const uncomment = (conf) => conf.replace(/#[^\n]*/g, '');

/**
 * add_header groups: the server level and every `location` block that declares add_header
 * directives of its own (nginx inheritance: such a block must repeat the CSP).
 * Returns the block texts with nested blocks removed, which is enough for these files.
 */
function headerGroups(conf) {
  const groups = [];
  /** @type {{ text: string, head: string, kind: string }[]} */
  const stack = [{ text: '', head: '', kind: 'top' }];
  let token = '';
  for (const ch of conf) {
    if (ch === '{') {
      stack.push({
        text: '',
        head: token.trim().replace(/^location\s+/, ''),
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

/** `add_header <name> <value>` values of one header group (quotes removed). */
function headerValues(text, name) {
  const re = new RegExp(`add_header\\s+${name}\\s+("[^"]*"|\\S+?)(\\s+always)?\\s*;`, 'gi');
  return [...text.matchAll(re)].map((m) => ({
    value: (m[1] ?? '').replace(/^"|"$/g, ''),
    always: Boolean(m[2]),
  }));
}

/** Puzzle CORS rules (map value; puzzle locations of a vhost). */
function checkPuzzleCors(name, conf, spec) {
  const errors = [];
  const maps = [...conf.matchAll(CORS_MAP_RE)];
  if (spec.corsMap && maps.length === 0) {
    errors.push(`${name}: no \`map $http_origin $${APP_CORS_VAR} { … }\` block`);
  }
  for (const m of maps) {
    const entries = (m[1] ?? '')
      .split(';')
      .map((e) => e.trim())
      .filter(Boolean);
    const want = ['default ""', ...EXPECTED_CORS_ORIGINS.map((o) => `"${o}" $http_origin`)].sort();
    const have = entries.map((e) => e.replace(/\s+/g, ' ')).sort();
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      errors.push(
        `${name}: $${APP_CORS_VAR} must echo exactly ${EXPECTED_CORS_ORIGINS.join(', ')} (default "")\n  have:     ${have.join('; ')}\n  expected: ${want.join('; ')}`,
      );
    }
  }
  const groups = headerGroups(conf);
  const found = new Set();
  for (const g of groups) {
    const cache = PUZZLE_LOCATIONS[g.head];
    const acao = headerValues(g.text, 'Access-Control-Allow-Origin');
    const corp = headerValues(g.text, 'Cross-Origin-Resource-Policy');
    if (cache === undefined) {
      if (acao.length > 0)
        errors.push(
          `${name}: Access-Control-Allow-Origin outside the puzzle locations (${g.head || 'server'})`,
        );
      if (corp.some((c) => c.value !== 'same-origin'))
        errors.push(
          `${name}: Cross-Origin-Resource-Policy other than same-origin outside the puzzle locations (${g.head || 'server'})`,
        );
      continue;
    }
    found.add(g.head);
    const where = `${name}: location ${g.head}`;
    const cc = headerValues(g.text, 'Cache-Control').map((c) => c.value);
    if (cc.length !== 1 || cc[0] !== cache)
      errors.push(`${where}: Cache-Control must be "${cache}"`);
    if (acao.length !== 1 || acao[0]?.value !== `$${APP_CORS_VAR}` || !acao[0]?.always)
      errors.push(
        `${where}: needs \`add_header Access-Control-Allow-Origin $${APP_CORS_VAR} always;\``,
      );
    const vary = headerValues(g.text, 'Vary');
    if (vary.length !== 1 || vary[0]?.value !== 'Origin')
      errors.push(`${where}: needs \`add_header Vary "Origin"\``);
    if (corp.length !== 1 || corp[0]?.value !== 'cross-origin')
      errors.push(`${where}: Cross-Origin-Resource-Policy must be "cross-origin"`);
    for (const h of [
      'Cross-Origin-Opener-Policy',
      'Cross-Origin-Embedder-Policy',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Strict-Transport-Security',
    ]) {
      if (headerValues(g.text, h).length !== 1)
        errors.push(`${where}: missing ${h} (full header group)`);
    }
    if (!/\btry_files\s+\$uri\s+=404\s*;/.test(g.text))
      errors.push(`${where}: needs \`try_files $uri =404;\``);
  }
  if (spec.puzzles) {
    for (const loc of Object.keys(PUZZLE_LOCATIONS)) {
      if (!found.has(loc)) errors.push(`${name}: no \`location ${loc}\` with its own header group`);
    }
  }
  return errors;
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
  errors.push(...checkPuzzleCors(name, conf, spec));
  if (spec.uses) {
    const anyMaps = [...conf.matchAll(ANY_MAP_RE)].map((m) => m[1]);
    if (spec.maps?.length === 0 && anyMaps.length > 0) {
      errors.push(
        `${name}: vhost declares map(s) ${anyMaps.map((v) => `$${v}`).join(', ')}; they belong in daisychess-common.conf`,
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
