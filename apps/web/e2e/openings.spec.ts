import { expect, test, type Page } from '@playwright/test';

const opening = (page: Page) => page.getByTestId('opening');

async function squareCentre(page: Page, sq: string) {
  const box = await page.locator('cg-board').boundingBox();
  if (!box) throw new Error('cg-board has no box');
  const s = box.width / 8;
  return {
    x: box.x + (sq.charCodeAt(0) - 97 + 0.5) * s,
    y: box.y + (7 - (Number(sq[1]) - 1) + 0.5) * s,
  };
}

async function click(page: Page, sq: string) {
  const p = await squareCentre(page, sq);
  await page.mouse.click(p.x, p.y);
}

/** Click-click move; waits until the FEN field shows `turn` to move after it (the move landed). */
async function move(page: Page, from: string, to: string, turn: 'w' | 'b') {
  await click(page, from);
  await expect(page.locator(`cg-board square.selected`)).toHaveCount(1);
  await click(page, to);
  await expect(page.getByLabel('FEN')).toHaveValue(new RegExp(` ${turn} `), { timeout: 5_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
});

test('opening name follows play, navigation and imports', async ({ page }) => {
  await expect(opening(page)).toBeHidden();
  await move(page, 'e2', 'e4', 'b');
  await move(page, 'e7', 'e5', 'w');
  await move(page, 'g1', 'f3', 'b');
  await page.getByRole('tab', { name: 'Moves' }).click();
  const list = page.getByTestId('movelist');
  await expect(list.locator('button[aria-label]')).toHaveCount(3, { timeout: 5_000 });
  // The openings chunk is lazy: allow it time to load under a busy full-suite run.
  await expect(opening(page)).toContainText('C40', { timeout: 10_000 });
  await expect(opening(page)).toContainText("King's Knight Opening");

  await page.getByRole('button', { name: '1. e4' }).click();
  await expect(opening(page)).toContainText('B00', { timeout: 5_000 });
  await expect(opening(page)).toContainText("King's Pawn Game");
});

test('imported PGN and custom FEN', async ({ page }) => {
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
  await page.getByRole('button', { name: 'Load PGN' }).click();
  await page.getByRole('tab', { name: 'Moves' }).click();
  await expect(page.getByTestId('movelist').locator('button[aria-label]')).toHaveCount(6);
  await page.getByRole('button', { name: 'Last move' }).click();
  await expect(page.getByLabel('FEN')).toHaveValue(/ w KQkq - 0 4$/);
  await expect(opening(page)).toContainText('Ruy Lopez', { timeout: 10_000 });

  await page.getByRole('tab', { name: 'Import' }).click();
  const target = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
  await page.getByLabel('Position to import').fill(target);
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.getByLabel('FEN')).toHaveValue(target);
  await expect(opening(page)).toBeHidden();
});
