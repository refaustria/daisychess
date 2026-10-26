import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SITE_CSP } from '../csp.config.mjs';
import { PAGES } from '../site.config';
import { watchProblems } from './helpers';

const SERIOUS = new Set(['serious', 'critical']);

for (const meta of PAGES) {
  for (const motion of ['no-preference', 'reduce'] as const) {
    test(`${meta.path} loads cleanly with the production CSP (motion: ${motion})`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: motion });
      const problems = await watchProblems(page);
      const res = await page.goto(meta.path);
      expect(res?.status()).toBe(200);
      expect(res?.headers()['content-security-policy']).toBe(SITE_CSP);
      await expect(page).toHaveTitle(meta.title);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('main#main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      if (meta.key === 'home' && motion === 'no-preference') {
        await expect(page.locator('html')).toHaveAttribute('data-hero', '3d', { timeout: 15_000 });
      }
      // Give animations and lazy chunks a moment, then scroll through the page once.
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, 'horizontal overflow (px)').toBeLessThanOrEqual(0);
      expect(problems.console, 'console errors').toEqual([]);
      expect(problems.csp, 'CSP violations').toEqual([]);
    });
  }

  test(`${meta.path} has no serious or critical axe violations`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(meta.path);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
      .analyze();
    const bad = results.violations.filter((v) => SERIOUS.has(v.impact ?? ''));
    expect(
      bad.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`),
    ).toEqual([]);
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`home and features pass axe in ${scheme} mode with motion`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'no-preference' });
    for (const path of ['/', '/features/', '/nodes/']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1200);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const bad = results.violations.filter((v) => SERIOUS.has(v.impact ?? ''));
      expect(
        bad.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
      ).toEqual([]);
    }
  });
}

test('legal pages carry no placeholders or draft banners', async ({ page }) => {
  for (const path of ['/privacy/', '/terms/', '/imprint/']) {
    await page.goto(path);
    await expect(page.locator('.draft-banner')).toHaveCount(0);
    await expect(page.locator('.ph')).toHaveCount(0);
    await expect(page.locator('article')).not.toContainText(/\[[A-Z][A-Z ,/&'-]{3,}|OWNER/);
  }
  await page.goto('/support/');
  await expect(page.locator('a[href="mailto:hello@daisychess.org"]').first()).toBeVisible();
});

test('imprint names the company register and VAT ID', async ({ page }) => {
  await page.goto('/imprint/');
  await expect(page.locator('article')).toContainText('FN 400396v');
  await expect(page.locator('article')).toContainText('ATU68207022');
});

test('skip link moves focus to the main content', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/features/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
  await expect(page.locator('main#main')).toBeFocused();
});

test('no horizontal scroll at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const meta of PAGES) {
    await page.goto(meta.path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, meta.path).toBeLessThanOrEqual(0);
  }
});

test('mobile navigation opens with the keyboard and closes with Escape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const toggle = page.locator('.nav-toggle');
  await expect(toggle).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Features' }),
  ).toBeHidden();
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Features' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('no request ever leaves the origin', async ({ page }) => {
  const foreign: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname !== 'localhost') foreign.push(r.url());
  });
  for (const meta of PAGES) {
    await page.goto(meta.path);
    await page.waitForLoadState('networkidle');
  }
  expect(foreign).toEqual([]);
});
