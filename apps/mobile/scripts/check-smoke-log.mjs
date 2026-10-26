#!/usr/bin/env node
// Asserts the native smoke result (ADR-022; apps/web/src/platform/smoke.ts) in a device log:
// Android logcat (`Capacitor/Console`) or the iOS app's stdout (Capacitor prints JS console lines).
// Usage: node scripts/check-smoke-log.mjs <log file> <android|ios> [--expect-welcome]
//   --expect-welcome: the build had VITE_MOBILE_SMOKE_SERVER_URL; the app must have received
//   `welcome` from that engine server (M26-2: the hub accepts the app's WebView origin).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SMOKE_MARKER = 'DAISYCHESS_SMOKE';

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/**
 * The last smoke result in `log`, or null. Lines carry a platform prefix (logcat: `… Msg: `,
 * iOS: `⚡️  [log] - `); the JSON object runs to the end of the line.
 * @param {string} log
 * @returns {Record<string, unknown> | null}
 */
export function findSmokeResult(log) {
  let found = null;
  for (const line of log.split(/\r?\n/)) {
    const at = line.lastIndexOf(`${SMOKE_MARKER} {`);
    if (at < 0) continue;
    const json = line.slice(at + SMOKE_MARKER.length + 1).trim();
    try {
      const v = JSON.parse(json);
      if (v && typeof v === 'object') found = v;
    } catch {
      // A truncated line (logcat splits at ~4 kB) is not a result.
    }
  }
  return found;
}

/**
 * @param {Record<string, unknown> | null} r
 * @param {string} platform expected `platform` field
 * @param {{ expectWelcome?: boolean }} [opts]
 * @returns {string[]} errors (empty = ok)
 */
export function checkSmokeResult(r, platform, opts = {}) {
  if (!r) return [`no ${SMOKE_MARKER} line in the log`];
  /** @type {string[]} */
  const errors = [];
  if (r.platform !== platform) errors.push(`platform ${String(r.platform)}, expected ${platform}`);
  if (r.isSecureContext !== true) errors.push('isSecureContext is not true');
  if (r.crossOriginIsolated !== false) errors.push('crossOriginIsolated is not false');
  if (r.engine !== 'wasm:lite-single') errors.push(`engine ${String(r.engine)}`);
  if (typeof r.bestmove !== 'string' || !UCI_MOVE.test(r.bestmove)) {
    errors.push(`no bestmove (${String(r.bestmove)})`);
  }
  if (r.error !== undefined) errors.push(`error: ${String(r.error)}`);
  if (opts.expectWelcome) {
    const s = /** @type {Record<string, unknown> | undefined} */ (
      r.server && typeof r.server === 'object' ? r.server : undefined
    );
    if (!s) errors.push('no server result (built without VITE_MOBILE_SMOKE_SERVER_URL?)');
    else if (s.welcome !== true)
      errors.push(`no welcome from ${String(s.url)}${s.error ? ` (${String(s.error)})` : ''}`);
  }
  return errors;
}

function main() {
  const [file, platform, ...flags] = process.argv.slice(2);
  const unknown = flags.filter((f) => f !== '--expect-welcome');
  if (!file || (platform !== 'android' && platform !== 'ios') || unknown.length) {
    console.error('usage: check-smoke-log.mjs <log file> <android|ios> [--expect-welcome]');
    process.exit(2);
  }
  const result = findSmokeResult(readFileSync(file, 'utf8'));
  const errors = checkSmokeResult(result, platform, {
    expectWelcome: flags.includes('--expect-welcome'),
  });
  console.log(`smoke result: ${JSON.stringify(result)}`);
  if (errors.length) {
    console.error(`smoke check failed:\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  console.log('smoke check: ok');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
