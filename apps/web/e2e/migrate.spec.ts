import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { expect, test, type BrowserContext } from '@playwright/test';
import { LEGACY_CSP } from '../csp.config.mjs';

// ADR-021: state moves from the legacy origin c.referee.at to play.daisychess.org in the URL
// fragment (#migrate=…), imported once on app start.

const MOVED = 'Your settings were moved from c.referee.at';
const ROOM = 'AbCdEfGhIjKlMnOpQrStUv';
const settings = { serverToken: 'migrated-token-42', coordinates: false };

const pack = (o: unknown) =>
  `1.${deflateRawSync(Buffer.from(JSON.stringify(o))).toString('base64url')}`;

test('#migrate= from c.referee.at imports the settings, strips the fragment and shows the notice', async ({
  page,
}) => {
  const payload = pack({
    v: 1,
    items: {
      'daisychess.settings': JSON.stringify(settings),
      'daisychess.theme': 'dark',
      'daisychess.nick': 'Mover',
    },
  });
  await page.goto(`/#migrate=${payload}`, { referer: 'https://c.referee.at/' });
  await expect(page.locator('cg-board')).toBeVisible();
  await expect(page.getByTestId('app-notice')).toContainText(MOVED);
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Server access token')).toHaveValue('migrated-token-42');
  expect(await page.evaluate(() => localStorage.getItem('daisychess.nick'))).toBe('Mover');

  // One-time: a reload shows no notice and keeps the settings.
  await page.reload();
  await expect(page.locator('cg-board')).toBeVisible();
  await expect(page.getByTestId('app-notice')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Server access token')).toHaveValue('migrated-token-42');
});

test('a crafted #migrate= link from anywhere else imports nothing', async ({ page }) => {
  const payload = pack({ v: 1, items: { 'daisychess.settings': JSON.stringify(settings) } });
  await page.goto(`/#migrate=${payload}`);
  await expect(page.locator('cg-board')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.getByTestId('app-notice')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('daisychess.settings'))).toBeNull();
});

test('existing settings on play.daisychess.org are never overwritten', async ({ page }) => {
  await page.goto('/?seed=1'); // a different document: the next goto is a full load, not a hash change
  await page.evaluate(() =>
    localStorage.setItem('daisychess.settings', JSON.stringify({ serverToken: 'mine' })),
  );
  await page.goto(
    `/#migrate=${pack({ v: 1, items: { 'daisychess.settings': JSON.stringify(settings) } })}`,
    {
      referer: 'https://c.referee.at/',
    },
  );
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Server access token')).toHaveValue('mine');
});

/**
 * Both origins in one browser: c.referee.at serves the real legacy page (apps/web/legacy/, with
 * its production CSP), play.daisychess.org is the preview build behind a route.
 */
async function wireOrigins(context: BrowserContext, baseURL: string) {
  const legacy = new URL('../legacy/', import.meta.url);
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
  };
  await context.route('https://c.referee.at/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/seed')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>seed</title>',
      });
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!['index.html', 'moved.js', 'migrate-core.js', 'moved.css'].includes(file))
      return route.fulfill({ status: 404 });
    return route.fulfill({
      body: readFileSync(new URL(file, legacy)),
      headers: {
        'content-type': types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
        'content-security-policy': LEGACY_CSP,
        'referrer-policy': 'strict-origin',
      },
    });
  });
  await context.route('https://play.daisychess.org/**', async (route) => {
    const u = new URL(route.request().url());
    const response = await route.fetch({ url: `${baseURL}${u.pathname}${u.search}` });
    return route.fulfill({ response });
  });
}

test('end to end: the legacy page on c.referee.at hands over to play.daisychess.org', async ({
  context,
  page,
  baseURL,
}) => {
  await wireOrigins(context, baseURL!);
  await page.goto('https://c.referee.at/seed');
  await page.evaluate(
    ([s, room]) => {
      localStorage.setItem('daisychess.settings', s);
      localStorage.setItem('daisychess.theme', 'dark');
      localStorage.setItem('daisychess.lichess.pkce', '{"verifier":"never-moves"}');
      localStorage.setItem(
        `daisychess.room.${room}`,
        JSON.stringify({
          playerToken: 'p'.repeat(43),
          color: 'white',
          nick: 'A',
          savedAt: Date.now(),
        }),
      );
    },
    [JSON.stringify(settings), ROOM] as const,
  );
  await page.goto('https://c.referee.at/');
  await page.waitForURL((u) => u.host === 'play.daisychess.org');
  await expect(page.locator('cg-board')).toBeVisible();
  await expect(page.getByTestId('app-notice')).toContainText(MOVED);
  expect(new URL(page.url()).hash).toBe('');
  const moved = await page.evaluate(() => ({
    settings: localStorage.getItem('daisychess.settings'),
    theme: localStorage.getItem('daisychess.theme'),
    pkce: localStorage.getItem('daisychess.lichess.pkce'),
    keys: Object.keys(localStorage).sort(),
  }));
  expect(moved.settings).toBe(JSON.stringify(settings));
  expect(moved.theme).toBe('dark');
  expect(moved.pkce).toBeNull();
  expect(moved.keys).toContain(`daisychess.room.${ROOM}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Server access token')).toHaveValue('migrated-token-42');
});
