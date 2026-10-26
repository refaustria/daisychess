#!/usr/bin/env node
// Asserts the native smoke result (ADR-022; apps/web/src/platform/smoke.ts) in a device log:
// Android logcat (`Capacitor/Console`) or the iOS app's stdout (Capacitor prints JS console lines).
// Usage: node scripts/check-smoke-log.mjs <log file> <android|ios>
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
 * @returns {string[]} errors (empty = ok)
 */
export function checkSmokeResult(r, platform) {
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
  return errors;
}

function main() {
  const [file, platform] = process.argv.slice(2);
  if (!file || (platform !== 'android' && platform !== 'ios')) {
    console.error('usage: check-smoke-log.mjs <log file> <android|ios>');
    process.exit(2);
  }
  const result = findSmokeResult(readFileSync(file, 'utf8'));
  const errors = checkSmokeResult(result, platform);
  console.log(`smoke result: ${JSON.stringify(result)}`);
  if (errors.length) {
    console.error(`smoke check failed:\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  console.log('smoke check: ok');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
