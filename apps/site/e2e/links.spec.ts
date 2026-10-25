import { expect, test } from '@playwright/test';
import { PAGES, SITE_URL } from '../site.config';

test('every internal link and fragment resolves', async ({ page, request }) => {
  const checked = new Map<string, number>();
  const idsByPath = new Map<string, Set<string>>();
  const broken: string[] = [];

  const idsOf = async (path: string) => {
    if (!idsByPath.has(path)) {
      await page.goto(path);
      const ids = await page.$$eval('[id]', (els) => els.map((e) => e.id));
      idsByPath.set(path, new Set(ids));
    }
    return idsByPath.get(path)!;
  };

  for (const meta of PAGES) {
    await page.goto(meta.path);
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href') ?? ''));
    for (const raw of hrefs) {
      let href = raw;
      if (href.startsWith(SITE_URL)) href = href.slice(SITE_URL.length) || '/';
      if (/^[a-z]+:/i.test(href)) continue; // external (play.daisychess.org, GitHub, …)
      const url = new URL(href, `http://x${meta.path}`);
      const path = url.pathname;
      if (!checked.has(path)) checked.set(path, (await request.get(path)).status());
      if (checked.get(path) !== 200) broken.push(`${meta.path} → ${raw} (${checked.get(path)})`);
      if (url.hash) {
        const ids = await idsOf(path);
        if (!ids.has(decodeURIComponent(url.hash.slice(1)))) broken.push(`${meta.path} → ${raw} (missing #id)`);
      }
    }
  }
  expect(broken).toEqual([]);
  expect(checked.size).toBeGreaterThanOrEqual(PAGES.length - 1);
});

test('static files and metadata exist', async ({ request }) => {
  for (const path of ['/robots.txt', '/sitemap.xml', '/og.png', '/favicon.svg', '/manifest.webmanifest', '/brand/apple-touch-icon.png', '/img/pawn-hero.png', '/img/pawn-hero.webp']) {
    expect((await request.get(path)).status(), path).toBe(200);
  }
  const sitemap = await (await request.get('/sitemap.xml')).text();
  expect(sitemap).toContain('<loc>https://daisychess.org/features/</loc>');
  expect(sitemap).not.toContain('404');
});

test('unknown paths answer 404 with the 404 page', async ({ page }) => {
  const res = await page.goto('/no/such/page/');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This square is empty.');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
});

test('every page has canonical and social metadata', async ({ page }) => {
  for (const meta of PAGES.filter((p) => p.index)) {
    await page.goto(meta.path);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', SITE_URL + meta.path);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', `${SITE_URL}/og.png`);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', meta.description);
  }
});
