import { expect, test } from '@playwright/test';
import { watchProblems } from './helpers';

const OUT = 'test-results/screenshots';

test('toggle switches theme, persists across reload, and stays CSP clean', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const problems = await watchProblems(page);
  await page.goto('/features/');
  const html = page.locator('html');
  await expect(html).not.toHaveAttribute('data-theme', /.+/);
  const btn = page.getByRole('button', { name: 'Switch to dark theme' });
  await expect(btn).toBeVisible();
  const bgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bgDark).not.toBe(bgLight);
  expect(await page.evaluate(() => localStorage.getItem('daisychess.theme'))).toBe('dark');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
  // Override beats the system preference in the other direction too.
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(bgLight);
  expect(problems.console).toEqual([]);
  expect(problems.csp).toEqual([]);
});

test('stored choice is applied before first paint (no inline script)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('daisychess.theme', 'dark'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('hero pawn follows the toggle live', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.locator('html[data-hero="3d"]').waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.waitForTimeout(500);
  await expect(page.locator('html')).toHaveAttribute('data-hero', '3d');
});

test('screenshots with the toggle visible', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.screenshot({ path: `${OUT}/theme-desktop-light.png` });
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.screenshot({ path: `${OUT}/theme-desktop-dark.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.removeItem('daisychess.theme'));
  await page.reload();
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await page.screenshot({ path: `${OUT}/theme-mobile-light.png` });
});
