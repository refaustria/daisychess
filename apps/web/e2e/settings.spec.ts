import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';

/** Luminance of the a1 (dark) and h1 (light) squares plus a1's RGB, sampled from a board screenshot. */
async function sample(page: Page) {
  const png = (await page.locator('cg-board').screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const s = img.width / 8;
    const at = (col: number, row: number) => {
      const [r, g, b] = ctx.getImageData(
        Math.round(col * s + 4),
        Math.round(row * s + 4),
        1,
        1,
      ).data;
      return { r: r!, g: g!, b: b!, lum: 0.2126 * r! + 0.7152 * g! + 0.0722 * b! };
    };
    return { a1: at(0, 7), h1: at(7, 7) };
  }, png);
}

const rootVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
});

test('board theme: blue changes colours and persists across reload', async ({ page }) => {
  const before = await sample(page);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Blue' }).click();
  expect(await rootVar(page, '--board-light')).toBe('#dee3e6');
  const after = await sample(page);
  expect(after.a1.lum).toBeLessThan(after.h1.lum);
  expect([after.a1.r, after.a1.g, after.a1.b]).not.toEqual([before.a1.r, before.a1.g, before.a1.b]);
  // #8ca2ad
  expect(Math.abs(after.a1.b - 0xad)).toBeLessThan(4);

  await page.reload();
  await expect(page.locator('cg-board')).toBeVisible();
  expect(await rootVar(page, '--board-light')).toBe('#dee3e6');
  const reloaded = await sample(page);
  expect(Math.abs(reloaded.a1.b - 0xad)).toBeLessThan(4);

  await page.getByRole('tab', { name: 'Settings' }).click();
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/settings.png`, fullPage: true });
});

test('coordinates toggle removes and restores coords', async ({ page }) => {
  await expect(page.locator('cg-board').locator('..').locator('coords').first()).toBeAttached();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Show coordinates').uncheck();
  await expect(page.locator('coords')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('cg-board')).toBeVisible();
  await expect(page.locator('coords')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Show coordinates').check();
  await expect(page.locator('coords').first()).toBeAttached();
});

test('piece set switch loads letters pieces and reset restores defaults', async ({ page }) => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Piece set').selectOption('letters');
  await expect(page.locator('cg-board')).toBeVisible();
  await expect(page.locator('[data-testid=board].cg-wrap.piece-set-letters')).toHaveCount(1);
  const bg = await page
    .locator('piece.pawn.white')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(decodeURIComponent(bg)).toContain('<text');
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(page.locator('[data-testid=board].piece-set-cburnett')).toHaveCount(1);
});
