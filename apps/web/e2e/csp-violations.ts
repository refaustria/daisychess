import { existsSync, readFileSync, rmSync } from 'node:fs';
import { CSP_REPORT_FILE } from '../csp.config.mjs';

interface CspReport {
  'effective-directive'?: string;
  'blocked-uri'?: string;
  'script-sample'?: string;
}

/**
 * Known-benign violations. zod v4 probes for JIT support with `new Function("")` inside a
 * try/catch and falls back to its interpreter when CSP blocks it; the probe still emits a
 * report. Matched exactly by the empty-function sample ('report-sample' in the preview CSP).
 * Remove once the app calls `z.config({ jitless: true })` at startup.
 */
function isBenign(r: CspReport): boolean {
  return (
    r['effective-directive'] === 'script-src' &&
    r['blocked-uri'] === 'eval' &&
    r['script-sample'] === '(function anonymous(\n) {\n\n})'
  );
}

/**
 * Playwright global setup/teardown: the preview server enforces the production CSP and posts
 * every violation to /__csp-report (vite.config.ts). The run fails on any non-benign report.
 */
export default function globalSetup(): () => void {
  rmSync(CSP_REPORT_FILE, { force: true });
  return () => {
    if (!existsSync(CSP_REPORT_FILE)) return;
    const lines = readFileSync(CSP_REPORT_FILE, 'utf8').split('\n').filter(Boolean);
    const offending = lines.filter((line) => {
      try {
        const { body } = JSON.parse(line) as { body: string };
        const report = (JSON.parse(body) as { 'csp-report'?: CspReport })['csp-report'] ?? {};
        return !isBenign(report);
      } catch {
        return true;
      }
    });
    if (offending.length > 0) {
      throw new Error(`Content-Security-Policy violations during e2e:\n${offending.join('\n')}`);
    }
  };
}
