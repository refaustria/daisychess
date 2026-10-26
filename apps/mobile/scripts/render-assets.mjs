/* global document */
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- plain Node scripts (Playwright and chess.js come from apps/web, untyped here)
// Renders the app icons, splash screens and Play/App Store graphics from the brand mark
// (apps/web/public/brand/daisy.svg) into the committed native projects and apps/mobile/store/.
// Run: node apps/mobile/scripts/render-assets.mjs   (Playwright/Chromium from apps/web; no other tools)
// See apps/mobile/store/README.md. Deterministic: re-running leaves `git diff` empty.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.join(here, '..');
const repo = path.join(mobile, '../..');
const { chromium } = createRequire(path.join(repo, 'apps/web/package.json'))('@playwright/test');

export const COLORS = {
  ivory: '#fbf8f1',
  dark: '#141311',
  text: '#1d1b17',
  textDark: '#f4f0e6',
  muted: '#59544a',
  yellow: '#f5c518',
  inkYellow: '#7a5600',
};

const svg = readFileSync(path.join(repo, 'apps/web/public/brand/daisy.svg'), 'utf8');
const font = readFileSync(
  path.join(repo, 'packages/ui-theme/src/fonts/inter-latin-wght-normal.woff2'),
).toString('base64');
const fontCss = `@font-face{font-family:'Inter Variable';font-weight:100 900;src:url(data:font/woff2;base64,${font}) format('woff2')}`;

const sized = (s, px) => s.replace(/width="\d+" height="\d+"/, `width="${px}" height="${px}"`);

/** Monochrome silhouette for Android themed icons: petals and pawn hint opaque, centre disc open. */
const monoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
<defs><ellipse id="p" cx="32" cy="14.5" rx="5.4" ry="12"/><mask id="m"><rect width="64" height="64" fill="#fff"/><circle cx="32" cy="32" r="9.5" fill="#000"/></mask></defs>
<g fill="#000" mask="url(#m)">${Array.from({ length: 14 }, (_, i) => `<use href="#p" transform="rotate(${((360 / 14) * i).toFixed(4)} 32 32)"/>`).join('')}</g>
<g fill="#000"><circle cx="32" cy="28.3" r="2.3"/><path d="M29.6 31.6h4.8l1 4.4h-6.8z"/><rect x="28.2" y="36" width="7.6" height="1.5" rx=".6"/></g></svg>`;

const browser = await chromium.launch();

/** Renders `html` in a w x h viewport; `channels` 3 = opaque RGB, 4 = RGBA (transparent allowed). */
async function render(html, w, h, channels, transparent = false) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>${fontCss}html,body{margin:0}body{width:${w}px;height:${h}px;overflow:hidden;font-family:'Inter Variable',system-ui,sans-serif}</style><body>${html}</body>`,
  );
  await page.evaluate(() => document.fonts.ready);
  const buf = await page.screenshot({ omitBackground: transparent });
  await page.close();
  return normalizePng(buf, channels);
}

function write(file, buf) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buf);
  console.log(path.relative(repo, file));
}

const centered = (bg, inner, extra = '') =>
  `<div style="width:100%;height:100%;background:${bg};display:grid;place-items:center;${extra}">${inner}</div>`;

// ---- iOS app icon: 1024, opaque ivory, no alpha ------------------------------------------------
const ios = path.join(mobile, 'ios/App/App/Assets.xcassets');
write(
  path.join(ios, 'AppIcon.appiconset/AppIcon-512@2x.png'),
  await render(centered(COLORS.ivory, sized(svg, 800)), 1024, 1024, 3),
);

// ---- Android: adaptive layers (108dp canvas, mark inside the 66dp safe zone), legacy icons ----
const res = path.join(mobile, 'android/app/src/main/res');
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, s] of Object.entries(densities)) {
  const canvas = 108 * s;
  const mark = Math.round(70 * s);
  write(
    path.join(res, `mipmap-${d}/ic_launcher_foreground.png`),
    await render(centered('transparent', sized(svg, mark)), canvas, canvas, 4, true),
  );
  write(
    path.join(res, `mipmap-${d}/ic_launcher_monochrome.png`),
    await render(centered('transparent', sized(monoSvg, mark)), canvas, canvas, 4, true),
  );
  const legacy = 48 * s;
  const markL = Math.round(legacy * 0.82);
  write(
    path.join(res, `mipmap-${d}/ic_launcher.png`),
    await render(
      centered(COLORS.ivory, sized(svg, markL), `border-radius:${legacy * 0.22}px`),
      legacy,
      legacy,
      4,
      true,
    ),
  );
  write(
    path.join(res, `mipmap-${d}/ic_launcher_round.png`),
    await render(
      centered(COLORS.ivory, sized(svg, Math.round(legacy * 0.8)), 'border-radius:50%'),
      legacy,
      legacy,
      4,
      true,
    ),
  );
}

// ---- Splash: ivory / dark background with the mark -----------------------------------------------
const splashHtml = (bg, w, h) => centered(bg, sized(svg, Math.round(Math.min(w, h) * 0.3)));
const androidSplash = {
  'drawable/splash.png': [480, 320],
  'drawable-land-mdpi/splash.png': [480, 320],
  'drawable-land-hdpi/splash.png': [800, 480],
  'drawable-land-xhdpi/splash.png': [1280, 720],
  'drawable-land-xxhdpi/splash.png': [1600, 960],
  'drawable-land-xxxhdpi/splash.png': [1920, 1280],
  'drawable-port-mdpi/splash.png': [320, 480],
  'drawable-port-hdpi/splash.png': [480, 800],
  'drawable-port-xhdpi/splash.png': [720, 1280],
  'drawable-port-xxhdpi/splash.png': [960, 1600],
  'drawable-port-xxxhdpi/splash.png': [1280, 1920],
};
for (const [rel, [w, h]] of Object.entries(androidSplash)) {
  write(path.join(res, rel), await render(splashHtml(COLORS.ivory, w, h), w, h, 3));
  // Night resources: the density qualifier comes last (drawable-port-night-hdpi).
  const night = rel.replace(
    /^drawable(-(?:land|port))?(-[a-z]+dpi)?\//,
    (_, o = '', den = '') => `drawable${o}-night${den}/`,
  );
  write(path.join(res, night), await render(splashHtml(COLORS.dark, w, h), w, h, 3));
}
const splashSet = path.join(ios, 'Splash.imageset');
const lightSplash = await render(splashHtml(COLORS.ivory, 2732, 2732), 2732, 2732, 3);
const darkSplash = await render(splashHtml(COLORS.dark, 2732, 2732), 2732, 2732, 3);
for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'])
  write(path.join(splashSet, f), lightSplash);
for (const f of [
  'splash-2732x2732-dark.png',
  'splash-2732x2732-dark-1.png',
  'splash-2732x2732-dark-2.png',
])
  write(path.join(splashSet, f), darkSplash);

// ---- Store graphics ----------------------------------------------------------------------------
const store = path.join(mobile, 'store');
// Google Play icon: 512 x 512, 32-bit PNG (alpha channel present), full bleed; Play applies the mask.
write(
  path.join(store, 'play-icon-512.png'),
  await render(centered(COLORS.ivory, sized(svg, 400)), 512, 512, 4),
);
// Apple marketing icon (same artwork as the app icon, opaque).
write(
  path.join(store, 'app-store-icon-1024.png'),
  await render(centered(COLORS.ivory, sized(svg, 800)), 1024, 1024, 3),
);
// Google Play feature graphic: 1024 x 500.
const feature = `<div style="width:100%;height:100%;position:relative;overflow:hidden;background:radial-gradient(circle at 20% 50%, rgba(245,197,24,.40), transparent 42%), ${COLORS.ivory};color:${COLORS.text};display:flex;align-items:center">
  <div style="margin-left:64px;flex:none">${sized(svg, 270)}</div>
  <div style="margin-left:52px">
    <div style="font-size:78px;font-weight:780;letter-spacing:-.04em;line-height:1">DaisyChess</div>
    <div style="font-size:34px;font-weight:600;line-height:1.3;margin-top:20px;color:${COLORS.text};letter-spacing:-.01em">Every move, <span style="background:linear-gradient(transparent 62%, ${COLORS.yellow} 62% 92%, transparent 92%)">understood.</span></div>
    <div style="font-size:25px;line-height:1.4;margin-top:18px;color:${COLORS.muted}">Free chess analysis with Stockfish and Maia.<br>Open source. No ads. No tracking.</div>
  </div></div>`;
write(path.join(store, 'play-feature-graphic-1024x500.png'), await render(feature, 1024, 500, 3));

await browser.close();
