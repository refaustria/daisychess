import { existsSync, readFileSync, rmSync } from 'node:fs';
import { CSP_REPORT_FILE } from '../csp.config.mjs';

/**
 * Playwright global setup/teardown: the preview server enforces the production CSP and posts
 * every violation to /__csp-report (vite.config.ts). The run fails on any report (there is no
 * allow-list; zod's JIT probe is disabled with `z.config({ jitless: true })` in main.tsx).
 */
export default function globalSetup(): () => void {
  rmSync(CSP_REPORT_FILE, { force: true });
  return () => {
    if (!existsSync(CSP_REPORT_FILE)) return;
    const lines = readFileSync(CSP_REPORT_FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 0) {
      throw new Error(`Content-Security-Policy violations during e2e:\n${lines.join('\n')}`);
    }
  };
}
