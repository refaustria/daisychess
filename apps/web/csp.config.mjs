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

/**
 * Loopback engine server of the CI native smoke (M26-2): `ws://127.0.0.1:<port>/ws` or
 * `ws://localhost:<port>/ws`. Nothing else is accepted, so a store build cannot widen its policy.
 */
const SMOKE_SERVER_URL = /^ws:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/ws$/;

/**
 * Self-hosted hubs (ADR-022 §4, M26-3): `hub=` setup links and `settings.remoteUrl` can point the
 * app at any `wss://` server, so the mobile policy allows secure WebSockets to any host. Only the
 * app's meta policy has it; the web/nginx policy (PRODUCTION_CSP) is unchanged.
 */
export const MOBILE_HUB_SOURCE = 'wss:';

/**
 * The meta policy of the mobile bundle (`vite build --mode mobile`, checked by
 * `apps/mobile/scripts/check-dist.mjs`): {@link metaCsp} with `wss:` ({@link MOBILE_HUB_SOURCE}) added to connect-src, plus — only in a CI smoke build
 * (`VITE_MOBILE_SMOKE=1`) with `VITE_MOBILE_SMOKE_SERVER_URL` set — that loopback server's origin
 * in connect-src. Throws for any other smoke server URL.
 * @param {Record<string, string | undefined>} [env]
 */
export function mobileMetaCsp(env = process.env) {
  const url = env.VITE_MOBILE_SMOKE === '1' ? env.VITE_MOBILE_SMOKE_SERVER_URL : undefined;
  if (url && !SMOKE_SERVER_URL.test(url)) {
    throw new Error(`VITE_MOBILE_SMOKE_SERVER_URL must be ws://127.0.0.1:<port>/ws, got ${url}`);
  }
  return metaCsp(buildCsp([MOBILE_HUB_SOURCE, ...(url ? [url.slice(0, -'/ws'.length)] : [])]));
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
