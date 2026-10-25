#!/usr/bin/env node
/* global window, document -- used inside page.evaluate / waitForFunction callbacks (browser context) */
// Renders the static images of the site and writes them into apps/site/public (committed):
//   img/pawn-hero.png + .webp  fallback for reduced motion / no WebGL / no JS (800x1000, transparent)
//   og.png                     Open Graph / Twitter card (1200x630)
// Usage: pnpm --filter @daisychess/site render-assets   (needs Playwright's Chromium; ImageMagick
// `magick` for the WebP, skipped with a warning when missing). Starts its own Vite dev server on a
// free port and stops it again.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const pub = `${root}public`;

const server = await createServer({ root, configFile: `${root}vite.config.ts`, server: { port: 0, strictPort: false }, logLevel: 'warn' });
await server.listen();
const addr = server.httpServer?.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const base = `http://localhost:${port}`;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 1000 }, deviceScaleFactor: 1 });
  page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()));
  await page.goto(`${base}/tools/render.html`);
  await page.waitForFunction(() => window.__rendered === true, null, { timeout: 60_000 });
  await page.locator('#stage').screenshot({ path: `${pub}/img/pawn-hero.png`, omitBackground: true });
  console.log('✓ public/img/pawn-hero.png');
  try {
    execFileSync('magick', [`${pub}/img/pawn-hero.png`, '-quality', '86', '-define', 'webp:alpha-quality=90', `${pub}/img/pawn-hero.webp`]);
    console.log('✓ public/img/pawn-hero.webp');
  } catch (e) {
    console.warn('! magick not available, pawn-hero.webp not updated', e instanceof Error ? e.message : e);
  }

  const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await og.goto(`${base}/tools/og.html`);
  await og.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map((i) => (i.complete ? null : new Promise((r) => (i.onload = r)))));
  });
  await og.locator('#og').screenshot({ path: `${pub}/og.png` });
  console.log('✓ public/og.png');
} finally {
  await browser.close();
  await server.close();
}
