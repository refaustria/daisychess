import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';

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

/** Click-click move (board oriented for White); waits until the move is on the board. */
async function move(page: Page, from: string, to: string, turn: 'w' | 'b') {
  await click(page, from);
  await expect(page.locator('cg-board square.selected')).toHaveCount(1);
  await click(page, to);
  await expect(page.getByLabel('FEN')).toHaveValue(new RegExp(` ${turn} `), { timeout: 5_000 });
}

test('openings drill: search, book move, engine-checked mistake, try again, book move', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Openings' }).click();

  await page.getByRole('searchbox', { name: 'Search openings' }).fill('Italian');
  const list = page.getByRole('list', { name: 'Openings' });
  const italian = list.getByRole('button').first();
  await expect(italian).toContainText('Italian Game');
  await expect(italian).toContainText('C50');
  await italian.click();
  await expect(page.getByTestId('opening-title')).toHaveText('C50 Italian Game');

  await page.getByRole('radio', { name: 'Drill' }).check({ force: true });
  await page.getByRole('radio', { name: 'White' }).check({ force: true });
  await page.getByRole('button', { name: 'Start drill' }).click();
  const feedback = page.getByTestId('drill-feedback');
  await expect(feedback).toHaveText('You play White: Italian Game. Your move.');
  await expect(page.getByTestId('player-bar-bottom')).toContainText('You');
  await expect(page.getByTestId('player-bar-top')).toContainText('Book (Italian Game)');

  // 1. e4 is book; the app answers with the line's 1...e5.
  await move(page, 'e2', 'e4', 'b');
  await expect(feedback).toContainText('Book reply e5', { timeout: 5_000 });
  await expect(page.getByLabel('FEN')).toHaveValue(
    /^rnbqkbnr\/pppp1ppp\/8\/4p3\/4P3\/8\/PPPP1PPP\/RNBQKBNR w KQkq - 0 2$/,
  );

  // 2. Ba6?? leaves the book and drops the bishop: the engine flags it.
  await move(page, 'f1', 'a6', 'b');
  await expect(feedback).toContainText(/Mistake: Ba6 loses \d+\.\d/, { timeout: 45_000 });
  await expect(feedback).toContainText('Best was');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/openings-drill.png`, fullPage: true });

  // Try again: back to the position after 1...e5, then 2. Nf3 is book.
  await retry.click();
  await expect(feedback).toHaveText('Try again: find a better move than Ba6.');
  await expect(page.getByLabel('FEN')).toHaveValue(/ w KQkq - 0 2$/);
  await move(page, 'g1', 'f3', 'b');
  await expect(feedback).toContainText(/^Book: |Book reply Nc6/, { timeout: 5_000 });
  await expect(page.getByTestId('drill-feedback')).not.toContainText('Mistake');
});
