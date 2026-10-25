// Regenerates PNG icons from public/brand/daisy.svg and the contact sheet. Run: node scripts/render-brand.mjs
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, '../public');
const svg = readFileSync(path.join(pub, 'brand/daisy.svg'), 'utf8');
const wm = readFileSync(path.join(pub, 'brand/daisy-wordmark.svg'), 'utf8');
const shots = path.join(root, '../test-results/screenshots');
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();
const sized = (s, px, w = px) => s.replace(/width="\d+" height="\d+"/, `width="${w}" height="${px}"`);
async function render(out, size, pad, bg) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const inner = size - 2 * pad;
  await page.setContent(`<body style="margin:0;background:${bg ?? 'transparent'};display:grid;place-items:center;width:${size}px;height:${size}px">${sized(svg, inner)}</body>`);
  await page.screenshot({ path: out, omitBackground: !bg });
  await page.close();
}
const b = (f) => path.join(pub, 'brand', f);
await render(b('icon-192.png'), 192, 8);
await render(b('icon-512.png'), 512, 20);
await render(b('apple-touch-icon.png'), 180, 18, '#ffffff');
await render(b('favicon-32.png'), 32, 0);
const cell = (bg, fg) => `<div style="background:${bg};color:${fg};padding:20px;display:flex;align-items:center;gap:24px">${[16, 32, 64, 180].map((n) => sized(svg, n)).join('')}${sized(wm, 64, 280)}</div>`;
const page = await browser.newPage({ viewport: { width: 760, height: 600 } });
await page.setContent(`<body style="margin:0">${cell('#ffffff', '#171412')}${cell('#171412', '#f2eee8')}</body>`);
await page.screenshot({ path: path.join(shots, 'brand-sheet.png'), fullPage: true });
await browser.close();
