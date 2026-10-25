import type { Page } from '@playwright/test';
import { PAGES } from '../site.config';

/** Every page path the site publishes (the 404 page by its file name). */
export const PAGE_PATHS = PAGES.map((p) => p.path);

export interface PageProblems {
  console: string[];
  csp: string[];
}

/**
 * Records console errors, uncaught exceptions and CSP violations of a page. Call before goto.
 * The violation listener is installed by Playwright (not as an inline script), so the CSP does not
 * block it.
 */
export async function watchProblems(page: Page): Promise<PageProblems> {
  const problems: PageProblems = { console: [], csp: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') problems.console.push(m.text());
  });
  page.on('pageerror', (e) => problems.console.push(`pageerror: ${e.message}`));
  await page.exposeFunction('__reportCsp', (s: string) => problems.csp.push(s));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __reportCsp(s: string): void }).__reportCsp(
        `${e.violatedDirective} blocked ${e.blockedURI} (${e.sourceFile}:${e.lineNumber})`,
      );
    });
  });
  return problems;
}
