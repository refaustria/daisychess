#!/usr/bin/env node
// Checks the mobile web build (`apps/web/dist-mobile`, ADR-022) before `cap sync` copies it into
// the native projects: only the lite-single engine, the CSP as a <meta http-equiv> equal to
// metaCsp() of apps/web/csp.config.mjs, no absolute asset URLs, size within budget, and the
// bundled puzzle starter set (apps/web/src/puzzles/data/starter.json, ADR-023 §4) ≤ 1 MB raw.
// Usage: node scripts/check-dist.mjs [distDir]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Upper bound for the bundled web assets; the store budget is 15 MB per platform (M26-1). */
export const MAX_DIST_BYTES = 8 * 1024 * 1024;

export const DEFAULT_DIST = fileURLToPath(new URL('../../web/dist-mobile', import.meta.url));

/**
 * Raw size limit of the puzzle starter set: STARTER_MAX_BYTES of @daisychess/puzzles (ADR-023 §4;
 * the pipeline asserts the same limit when it writes the file). Kept as a literal so this script
 * runs without building the package.
 */
export const STARTER_MAX_BYTES = 1_000_000;

export const DEFAULT_STARTER = fileURLToPath(
  new URL('../../web/src/puzzles/data/starter.json', import.meta.url),
);

/** @param {string} dir @returns {string[]} paths relative to `dir`, `/`-separated */
export function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

const ENGINE_FILE = /(^|\/)(stockfish-[^/]*\.(js|wasm))$/;

/**
 * Pure part of the check (unit-tested): the file list, index.html and the expected meta policy.
 * `starterBytes`: raw size of the bundled puzzle starter (`null` = file missing; `undefined` = not
 * checked).
 * @param {{ files: string[], indexHtml: string, expectedCsp: string, totalBytes: number, starterBytes?: number | null }} input
 * @returns {string[]} errors (empty = ok)
 */
export function checkDist({ files, indexHtml, expectedCsp, totalBytes, starterBytes }) {
  /** @type {string[]} */
  const errors = [];
  const engines = files.map((f) => ENGINE_FILE.exec(f)?.[2]).filter((f) => f !== undefined);
  const want = /^stockfish-\d+-lite-single\.(js|wasm)$/;
  for (const e of engines) {
    if (!want.test(e)) errors.push(`unexpected engine file ${e} (mobile ships lite-single only)`);
  }
  for (const ext of ['js', 'wasm']) {
    if (!engines.some((e) => want.test(e) && e.endsWith(`.${ext}`))) {
      errors.push(`missing lite-single .${ext}`);
    }
  }

  const metas = [
    ...indexHtml.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi),
  ];
  if (metas.length !== 1) {
    errors.push(`index.html must carry exactly one CSP meta element (found ${metas.length})`);
  } else {
    const policy = (metas[0]?.[1] ?? '')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    if (policy !== expectedCsp)
      errors.push(`CSP meta differs from metaCsp():\n  ${policy}\n  ${expectedCsp}`);
    const head = indexHtml.indexOf('<head>');
    const firstScript = indexHtml.indexOf('<script');
    if (head < 0 || (metas[0]?.index ?? Infinity) > firstScript) {
      errors.push('CSP meta must come before the first <script>');
    }
  }

  for (const m of indexHtml.matchAll(/\s(?:src|href)="([^"]*)"/g)) {
    const url = m[1] ?? '';
    if (/^(https?:)?\/\//i.test(url)) errors.push(`absolute asset URL in index.html: ${url}`);
  }

  if (totalBytes > MAX_DIST_BYTES) {
    errors.push(`dist-mobile is ${totalBytes} bytes, budget ${MAX_DIST_BYTES}`);
  }
  if (starterBytes === null) {
    errors.push(
      'puzzle starter set missing (apps/web/src/puzzles/data/starter.json): no offline puzzles',
    );
  } else if (starterBytes !== undefined && starterBytes > STARTER_MAX_BYTES) {
    errors.push(
      `puzzle starter set is ${starterBytes} bytes, limit ${STARTER_MAX_BYTES} (ADR-023 §4)`,
    );
  }
  return errors;
}

/**
 * About → Licences (M26-6): the GPL text must be bundled but live in a lazy chunk, not in the entry.
 * @param {{ entry: string, chunks: Record<string, string> }} input entry JS source and all JS by file
 * @returns {string[]} errors
 */
export function checkLicenceChunk({ entry, chunks }) {
  const MARK = 'GNU GENERAL PUBLIC LICENSE';
  /** @type {string[]} */
  const errors = [];
  if (entry.includes(MARK)) errors.push('GPL text is in the main entry chunk (must be lazy)');
  if (!Object.values(chunks).some((c) => c.includes(MARK))) {
    errors.push('GPL text is missing from the bundle (About → Licences would not work offline)');
  }
  return errors;
}

async function main() {
  const dir = process.argv[2] ?? DEFAULT_DIST;
  const files = listFiles(dir);
  const totalBytes = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  const indexHtml = readFileSync(join(dir, 'index.html'), 'utf8');
  /** @type {{ mobileMetaCsp(): string }} */
  const csp = await import('../../web/csp.config.mjs');
  // Same policy as the build: the production meta policy, plus the loopback smoke server in a
  // CI smoke build (VITE_MOBILE_SMOKE=1 + VITE_MOBILE_SMOKE_SERVER_URL, M26-2).
  let starterBytes = null;
  try {
    starterBytes = statSync(DEFAULT_STARTER).size;
  } catch {
    // missing: reported by checkDist
  }
  const errors = checkDist({
    files,
    indexHtml,
    expectedCsp: csp.mobileMetaCsp(),
    totalBytes,
    starterBytes,
  });
  const jsFiles = files.filter((f) => f.endsWith('.js'));
  const entrySrc = /<script[^>]*\ssrc="([^"]*)"/.exec(indexHtml)?.[1] ?? '';
  const entryPath = entrySrc.replace(/^\.?\//, '');
  /** @type {Record<string, string>} */
  const chunks = {};
  for (const f of jsFiles) chunks[f] = readFileSync(join(dir, f), 'utf8');
  errors.push(...checkLicenceChunk({ entry: chunks[entryPath] ?? '', chunks }));
  // Absolute asset URLs inside the stylesheets (url(...)).
  for (const f of files.filter((x) => x.endsWith('.css'))) {
    const css = readFileSync(join(dir, f), 'utf8');
    for (const m of css.matchAll(/url\(\s*['"]?((?:https?:)?\/\/[^'")]*)/gi)) {
      errors.push(`absolute URL in ${f}: ${m[1]}`);
    }
  }
  if (errors.length) {
    console.error(`check-dist: ${dir}\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  console.log(
    `check-dist: ok (${files.length} files, ${(totalBytes / 1e6).toFixed(1)} MB; puzzle starter ${starterBytes} bytes)`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
