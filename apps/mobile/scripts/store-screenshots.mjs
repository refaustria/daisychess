/* global document, window, localStorage */
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- plain Node scripts (Playwright and chess.js come from apps/web, untyped here)
// Store screenshots from the mobile build (apps/web/dist-mobile, `pnpm --filter @daisychess/mobile build:web`).
// Run: node apps/mobile/scripts/store-screenshots.mjs [--size iphone-6.9] [--scene review] [--theme dark] [--out dir]
//
// The build is served from a throw-away static server (the CSP meta tag is dropped from index.html
// only for this harness so the page may reach the local engine server). A local engine server
// (apps/server/dist, Stockfish + Maia from engines/) is started on a free loopback port with a dummy
// access token; if lc0/Maia is missing the Maia screenshot falls back to the Stockfish opponent.
// The lichess opening explorer needs a login, so its responses are mocked (illustrative numbers, no
// players, no games). Every process started here is stopped by its handle, never by name.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.join(here, '..');
const repo = path.join(mobile, '../..');
const web = path.join(repo, 'apps/web');
const requireWeb = createRequire(path.join(web, 'package.json'));
const { chromium } = requireWeb('@playwright/test');
const { Chess } = requireWeb('chess.js');

/** Store screenshot sizes: pixel size = CSS viewport x scale. Limits: stores/screenshot-specs in test/store.test.ts. */
export const SIZES = {
  'play-phone': { store: 'google', width: 1080, height: 2160, scale: 3, touch: true },
  'play-tablet-7': { store: 'google', width: 1200, height: 1920, scale: 2, touch: true },
  'play-tablet-10': { store: 'google', width: 2560, height: 1600, scale: 2, touch: true },
  'iphone-6.9': { store: 'apple', width: 1320, height: 2868, scale: 3, touch: true },
  'ipad-13': { store: 'apple', width: 2064, height: 2752, scale: 2, touch: true },
};
/** Share of the canvas height the app screen is shown at; its CSS viewport is 0.94 H / scale high. */
const APP_HEIGHT = 0.8;
const APP_VIEWPORT_HEIGHT = 0.94;
/**
 * The six screenshots per size, by impact: five light, one dark. `focus` picks the part of a
 * one-column page that stays in view (`board`: board first; `half`: lower half of the board, cut at
 * a rank, plus the tab panel; `panel`: tab row at the top).
 */
export const SCENES = [
  { id: 'review', theme: 'light', focus: 'board', caption: 'See the better move' },
  { id: 'review-summary', theme: 'light', focus: 'panel', caption: 'Every move rated' },
  { id: 'play', theme: 'light', focus: 'board', caption: 'Play Maia at your level' },
  { id: 'openings', theme: 'light', focus: 'half', caption: 'Train your openings' },
  { id: 'explorer', theme: 'light', focus: 'half', caption: 'Explore the database' },
  { id: 'review', theme: 'dark', focus: 'board', caption: 'Light and dark themes' },
];

// A short, invented game (no real players): the Giuoco Piano with a mistake and a blunder by Black.
const PGN = `[Event "Casual game"]
[Site "DaisyChess"]
[Date "2026.05.01"]
[White "Alex"]
[Black "Sam"]
[Result "1-0"]
[WhiteElo "1520"]
[BlackElo "1480"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Nc3 Nxe4 8. O-O Bxc3 9. d5 Bf6 10. Re1 Ne7 11. Rxe4 d6 12. Bg5 Bxg5 13. Nxg5 h6 14. Qe2 hxg5 15. Re1 Be6 16. dxe6 f6 17. Qh5+ Kf8 18. Qf7# 1-0
`;
const REVIEW_PLY = 17; // after 9. d5: the Moller attack position, a clear classification and best-move arrow

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = opt('out') ?? path.join(mobile, 'store/screenshots');
const onlySize = opt('size');
const onlyScene = opt('scene');
const onlyTheme = opt('theme');
const TOKEN = 'store-screenshots-token';

const fontCss = `@font-face{font-family:'Inter Variable';font-weight:100 900;src:url(data:font/woff2;base64,${readFileSync(path.join(repo, 'packages/ui-theme/src/fonts/inter-latin-wght-normal.woff2')).toString('base64')}) format('woff2')}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.gz': 'application/gzip',
  '.nnue': 'application/octet-stream',
};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function serveDist(dir) {
  const root = path.resolve(dir);
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) return void res.writeHead(404).end();
    let body = readFileSync(file);
    if (file.endsWith('index.html')) {
      body = Buffer.from(
        body.toString('utf8').replace(/<meta[^>]*Content-Security-Policy[^>]*>/i, ''),
      );
    }
    res
      .writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
      .end(body);
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

async function startEngineServer(origin) {
  const entry = path.join(repo, 'apps/server/dist/index.js');
  if (!existsSync(entry))
    throw new Error('apps/server/dist missing: run pnpm --filter @daisychess/server build');
  const port = await freePort();
  const proc = spawn(process.execPath, [entry], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      ALLOWED_ORIGINS: origin,
      ACCESS_TOKEN: TOKEN,
      REVIEW_STORE: 'off',
      MAIA: 'on',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`engine server exited with ${proc.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('engine server did not start');
    await new Promise((r) => setTimeout(r, 150));
  }
  const stop = async () => {
    if (proc.exitCode !== null) return;
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    const t = setTimeout(() => proc.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(t);
  };
  return { url: `ws://127.0.0.1:${port}/ws`, stop };
}

const EXPLORER = {
  white: 41_800,
  draws: 5_900,
  black: 38_300,
  opening: { eco: 'C54', name: 'Italian Game: Giuoco Piano, Main Line' },
  moves: [
    {
      uci: 'g8f6',
      san: 'Nf6',
      averageRating: 1830,
      white: 17_900,
      draws: 2_300,
      black: 16_200,
      game: null,
      opening: null,
    },
    {
      uci: 'd7d6',
      san: 'd6',
      averageRating: 1790,
      white: 9_200,
      draws: 1_500,
      black: 8_300,
      game: null,
      opening: null,
    },
    {
      uci: 'f8e7',
      san: 'Be7',
      averageRating: 1810,
      white: 6_300,
      draws: 1_100,
      black: 5_700,
      game: null,
      opening: null,
    },
    {
      uci: 'd8e7',
      san: 'Qe7',
      averageRating: 1760,
      white: 3_100,
      draws: 400,
      black: 2_800,
      game: null,
      opening: null,
    },
  ],
  topGames: [],
  recentGames: [],
};

/** Square centre in page coordinates (board with White at the bottom). */
async function squareCentre(page, sq) {
  const box = await page.locator('cg-board').boundingBox();
  const s = box.width / 8;
  return {
    x: box.x + (sq.charCodeAt(0) - 97 + 0.5) * s,
    y: box.y + (7 - (Number(sq[1]) - 1) + 0.5) * s,
  };
}
async function movePiece(page, from, to) {
  for (const sq of [from, to]) {
    const p = await squareCentre(page, sq);
    await page.mouse.click(p.x, p.y);
  }
}

async function openPage(browser, spec, theme, urls) {
  const ctx = await browser.newContext({
    viewport: {
      width: Math.round(spec.width / spec.scale),
      height: Math.round((spec.height * APP_VIEWPORT_HEIGHT) / spec.scale),
    },
    deviceScaleFactor: spec.scale,
    isMobile: true,
    hasTouch: spec.touch,
    colorScheme: theme,
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  await page.addInitScript(
    ({ url, token, theme: th }) => {
      localStorage.setItem(
        'daisychess.settings',
        JSON.stringify({
          serverToken: token,
          poolNoticeAccepted: true,
          sound: false,
          reviewTour: false,
        }),
      );
      localStorage.setItem(
        'daisychess.analysis',
        JSON.stringify({ enabled: false, settings: { depth: 12, multipv: 1, remoteUrl: url } }),
      );
      localStorage.setItem(
        'daisychess.explorer',
        JSON.stringify({ db: 'lichess', token: 'store-screenshots' }),
      );
      localStorage.setItem('daisychess.theme', th);
    },
    { url: urls.ws, token: TOKEN, theme },
  );
  await page.route('https://explorer.lichess.org/**', (route) =>
    route.fulfill({
      status: route.request().method() === 'OPTIONS' ? 204 : 200,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'Accept,Authorization',
        'content-type': 'application/json',
      },
      body: JSON.stringify(EXPLORER),
    }),
  );
  await page.goto(urls.origin + '/');
  await page.waitForSelector('cg-board');
  return page;
}

async function loadReview(page) {
  await page.getByRole('tab', { name: 'Import' }).click();
  const area = page.getByLabel('PGN text');
  await area.fill(PGN);
  await area.locator('xpath=following::button[1]').click();
}

async function applyFocus(page, focus) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  if (overflow > 4) {
    await page.evaluate((f) => {
      const top = (el) => el.getBoundingClientRect().top + window.scrollY;
      const maxY = document.documentElement.scrollHeight - window.innerHeight;
      let y = 0;
      if (f === 'board') y = top(document.querySelector('[data-testid="player-bar-top"]')) - 8;
      else if (f === 'panel') y = top(document.querySelector('[role="tablist"]')) - 8;
      else {
        // Lower half of the board (cut at a rank border) and the panel below it.
        const board = document.querySelector('cg-board').getBoundingClientRect();
        y = board.top + window.scrollY + board.height / 2;
      }
      if (y > maxY) document.body.style.paddingBottom = `${Math.ceil(y - maxY)}px`;
      window.scrollTo(0, Math.max(0, y));
    }, focus);
  }
  // Tab row: start at a whole tab (never "ves Play"), keeping the active tab in view.
  await page.evaluate(() => {
    const row = document.querySelector('[role="tablist"]');
    const tabs = [...row.querySelectorAll('[role="tab"]')];
    const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    if (!active) return;
    const base = tabs[0].offsetLeft;
    for (const t of tabs) {
      if (active.offsetLeft + active.offsetWidth - t.offsetLeft <= row.clientWidth - 4) {
        row.scrollLeft = t.offsetLeft - base;
        return;
      }
    }
  });
}

/** Wraps the raw app screenshot in the marketing layout: caption on top, the screen with rounded corners and a soft shadow. */
async function compose(browser, spec, theme, caption, appPng) {
  const { width: W, height: H } = spec;
  const dark = theme === 'dark';
  const portrait = H >= W;
  const fs = Math.round(portrait ? W * 0.075 : H * 0.062);
  const imgH = Math.round(H * APP_HEIGHT);
  const imgW = Math.round((imgH * W) / (H * APP_VIEWPORT_HEIGHT));
  const top = Math.round(H * 0.155);
  const bg = dark ? '#262320' : '#fbf8f1';
  const ink = dark ? '#f4f0e6' : '#1d1b17';
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${fontCss}
html,body{margin:0}body{width:${W}px;height:${H}px;overflow:hidden;position:relative;background:radial-gradient(circle at 50% 0%, rgba(245,197,24,${dark ? 0.16 : 0.3}), transparent 55%), ${bg};font-family:'Inter Variable',system-ui,sans-serif;color:${ink}}
h1{position:absolute;left:0;right:0;top:0;height:${top}px;margin:0;display:flex;align-items:center;justify-content:center;font-size:${fs}px;font-weight:780;letter-spacing:-.035em;white-space:nowrap}
img{position:absolute;left:${Math.round((W - imgW) / 2)}px;top:${top}px;width:${imgW}px;height:${imgH}px;border-radius:${Math.round(W * 0.03)}px;box-shadow:0 ${Math.round(H * 0.012)}px ${Math.round(H * 0.035)}px rgba(${dark ? '0,0,0,.55' : '40,30,10,.22'}),0 0 0 2px rgba(${dark ? '255,255,255,.08' : '40,30,10,.10'})}
</style><body><h1>${caption}</h1><img src="data:image/png;base64,${appPng.toString('base64')}"></body>`);
  await page.evaluate(() => document.fonts.ready);
  const out = await page.screenshot({ type: 'png' });
  await page.close();
  return normalizePng(out, 3);
}

const scenes = {
  async 'review-summary'(page) {
    await scenes.review(page);
    await page
      .getByRole('button', { name: 'Dismiss auto review notice' })
      .click()
      .catch(() => undefined);
  },
  async review(page) {
    await loadReview(page);
    await page.getByTestId('eval-graph').waitFor({ timeout: 120_000 });
    // go to the interesting ply (the board buttons: first, previous, next, last)
    await page
      .getByRole('button', { name: /first move|start/i })
      .first()
      .click()
      .catch(() => undefined);
    for (let i = 0; i < REVIEW_PLY; i++)
      await page
        .getByRole('button', { name: /next move/i })
        .first()
        .click();
  },
  async play(page) {
    await page.getByRole('tab', { name: 'Play' }).click();
    const strength = page.getByLabel('Strength');
    await strength.selectOption('maia-1500').catch(() => undefined);
    await page.getByRole('radio', { name: 'White' }).check();
    await page.getByRole('button', { name: 'Start' }).click();
    await page
      .getByTestId('play-status')
      .filter({ hasText: 'Your move' })
      .waitFor({ timeout: 20_000 });
    const wanted = ['e2e4', 'g1f3', 'f1c4', 'c2c3', 'd2d4', 'e1g1', 'b1d2', 'h2h3'];
    for (let n = 0; n < 4; n++) {
      const fen = await page.getByLabel('FEN').inputValue();
      const chess = new Chess(fen);
      const legal = chess.moves({ verbose: true }).map((m) => m.from + m.to);
      const next = wanted.find((m) => legal.includes(m));
      if (!next) break;
      await movePiece(page, next.slice(0, 2), next.slice(2, 4));
      await page
        .waitForFunction(
          (f) => document.querySelector('input[aria-label="FEN"]')?.value !== f,
          fen,
          { timeout: 15_000 },
        )
        .catch(() => undefined);
      await page
        .getByTestId('play-status')
        .filter({ hasText: 'Your move' })
        .waitFor({ timeout: 20_000 });
    }
  },
  async openings(page) {
    await page.getByRole('tab', { name: 'Openings' }).click();
    await page.getByRole('searchbox', { name: 'Search openings' }).fill('Italian');
    await page.getByRole('list', { name: 'Openings' }).getByRole('button').first().click();
    await page
      .getByRole('button', { name: /3\. Bc4/ })
      .first()
      .click();
  },
  async explorer(page) {
    await scenes.openings(page);
    await page.getByRole('tab', { name: 'Explorer' }).click();
    await page.getByText(/[\d,]+ games/).waitFor({ timeout: 15_000 });
  },
  async settings(page) {
    await page.getByRole('tab', { name: 'Settings' }).click();
  },
};

async function main() {
  const dist = path.join(web, 'dist-mobile');
  if (!existsSync(path.join(dist, 'index.html')))
    throw new Error('apps/web/dist-mobile missing: run pnpm --filter @daisychess/web build:mobile');
  const site = await serveDist(dist);
  let engine;
  const browser = await chromium.launch();
  const written = [];
  try {
    engine = await startEngineServer(site.origin);
    const urls = { origin: site.origin, ws: engine.url };
    for (const [sizeId, spec] of Object.entries(SIZES)) {
      if (onlySize && onlySize !== sizeId) continue;
      for (const [i, scene] of SCENES.entries()) {
        const { theme } = scene;
        if (onlyTheme && onlyTheme !== theme) continue;
        if (onlyScene && onlyScene !== scene.id) continue;
        const page = await openPage(browser, spec, theme, urls);
        try {
          await scenes[scene.id](page);
          await applyFocus(page, scene.focus);
          await page.waitForTimeout(600);
          const raw = await page.screenshot({ type: 'png' });
          const buf = await compose(browser, spec, theme, scene.caption, raw);
          const file = path.join(
            outDir,
            sizeId,
            `${String(i + 1).padStart(2, '0')}-${scene.id}-${theme}.png`,
          );
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, buf);
          written.push(file);
          console.log(path.relative(repo, file));
        } catch (err) {
          await page
            .screenshot({ path: path.join(outDir, `FAILED-${sizeId}-${scene.id}-${theme}.png`) })
            .catch(() => undefined);
          throw err;
        } finally {
          await page.context().close();
        }
      }
    }
  } finally {
    await browser.close();
    await engine?.stop();
    await site.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
