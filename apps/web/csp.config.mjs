// Content-Security-Policy for the DaisyChess SPA (docs/SECURITY.md, "Content-Security-Policy").
// Single source of truth: vite.config.ts sends it from `vite preview`, and
// `node scripts/check-csp.mjs` verifies that the nginx configs (deploy/nginx, docker) carry
// exactly PRODUCTION_CSP. Plain ESM so the check script runs on Node 20 without a TS loader.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `'sha256-…'` sources for every inline <script> (no attributes) in the given HTML. */
export function inlineScriptHashes(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) =>
      `'sha256-${createHash('sha256')
        .update(m[1] ?? '')
        .digest('base64')}'`,
  );
}

/** Public host of the app (ADR-021). */
export const APP_HOST = 'play.daisychess.org';

const indexHtml = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

/** Production policy; `extraConnect` appends connect-src sources (used for e2e only). */
export function buildCsp(extraConnect = []) {
  return [
    "default-src 'self'",
    // Only inline script: the static theme bootstrap in index.html, allowed by hash.
    // 'wasm-unsafe-eval': WebAssembly compilation in the Stockfish worker. No 'unsafe-eval'.
    ["script-src 'self'", ...inlineScriptHashes(indexHtml), "'wasm-unsafe-eval'"].join(' '),
    // Engine worker and Emscripten pthread workers load from same-origin URLs (no blob:).
    "worker-src 'self'",
    // Stylesheets only. React style props and chessground write through the CSSOM, which
    // style-src does not govern, so no 'unsafe-inline'.
    "style-src 'self'",
    // Piece sets and chessground board SVGs are data: URIs.
    "img-src 'self' data:",
    "font-src 'self'",
    // Engine server WebSocket (same origin), the online game import APIs and the lichess opening explorer.
    [
      `connect-src 'self' https://lichess.org https://explorer.lichess.org https://api.chess.com wss://${APP_HOST}`,
      ...extraConnect,
    ].join(' '),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const PRODUCTION_CSP = buildCsp();

/**
 * Directives a `<meta http-equiv="Content-Security-Policy">` cannot carry (CSP3 §3.3: they are
 * ignored there and the browser logs an error for each).
 */
const META_UNSUPPORTED = ['frame-ancestors', 'report-uri', 'sandbox'];

/**
 * The policy for a `<meta http-equiv>` (the mobile build, ADR-022, has no server to send the
 * header): `policy` minus the directives a meta element cannot carry. Defaults to PRODUCTION_CSP,
 * so the app enforces the same sources as play.daisychess.org.
 */
export function metaCsp(policy = PRODUCTION_CSP) {
  return policy
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !META_UNSUPPORTED.includes(d.split(/\s+/)[0] ?? ''))
    .join('; ');
}

/** hub.daisychess.org serves no documents, only /link (WebSocket) and /health (JSON). */
export const HUB_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * Where `vite preview` appends CSP violation reports; e2e/csp-violations.ts fails the run on any.
 * Per E2E_PORT, so concurrent Playwright runs (playwright.config.ts) do not share the file.
 */
export const CSP_REPORT_FILE = fileURLToPath(
  new URL(
    `./node_modules/.cache/daisychess/csp-violations-${process.env.E2E_PORT ?? '4180'}.jsonl`,
    import.meta.url,
  ),
);
