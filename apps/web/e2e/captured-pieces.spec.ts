import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
const GAME = '1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. Nf3 Nf6 5. Bb5+ c6 6. Bxc6+ bxc6 *';

test('captured pieces and material advantage follow the position', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(GAME);
  await page.getByRole('button', { name: 'Load PGN' }).click();

  await page.getByRole('button', { name: 'Last move' }).click();
  const white = page.getByTestId('captured-white');
  const black = page.getByTestId('captured-black');
  // Black ends two pawns down but took a bishop and a pawn: black is +2.
  await expect(white).toHaveAttribute('aria-label', 'captured: 2 pawns');
  await expect(black).toHaveAttribute('aria-label', 'captured: 1 bishop, 1 pawn, +2');
  await expect(page.getByTestId('advantage-black')).toHaveText('+2');
  await expect(page.getByTestId('advantage-white')).toHaveCount(0);

  // Player bars keep their height whether or not pieces are shown.
  const bar = page.getByTestId('player-bar-top');
  const h = (await bar.boundingBox())!.height;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/captured-pieces.png` });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: `${SHOTS}/captured-pieces-dark.png` });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  // Stepping back to the position after 2...Qxd5: one pawn each, equal.
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft');
  await expect(white).toHaveAttribute('aria-label', 'captured: 1 pawn');
  await expect(black).toHaveAttribute('aria-label', 'captured: 1 pawn');
  await expect(page.getByTestId('advantage-black')).toHaveCount(0);
  expect((await bar.boundingBox())!.height).toBe(h);
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  await expect(white).toHaveCount(0);
  await expect(black).toHaveCount(0);
  await page.getByRole('button', { name: 'Last move' }).click();
  await expect(black).toHaveAttribute('aria-label', /\+2$/);

  // Icons are drawn with the sprites of the piece set, also for "letters".
  const icon = white.locator('piece.black.pawn').first();
  expect(await icon.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('url(');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Piece set').selectOption('letters');
  await expect(white.locator('piece').first()).toHaveCSS('background-image', /<text|%3Ctext/);
  expect(await icon.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(12);

  // Mobile: no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(black).toBeVisible();
});
