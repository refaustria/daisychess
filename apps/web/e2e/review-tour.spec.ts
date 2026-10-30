import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Guided review tour (M20-2, ADR-024 / M31-9): browser review of a fixture game, no server.
 * Giuoco Pianissimo (Italian family) with ten sound White moves after the book, then 20. Nd5??
 * hangs a knight (the Elo fallback needs 10 scored moves per side).
 */
const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
const PGN =
  '[Event "Casual"]\n[White "Ann"]\n[Black "Bob"]\n\n' +
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3 Bc5 5. c3 d6 6. O-O O-O 7. Re1 a6 8. Bb3 Ba7 9. Nbd2 Re8 ' +
  '10. Nf1 h6 11. Ng3 Be6 12. Bxe6 Rxe6 13. h3 Qd7 14. Nh2 Rd8 15. Nhf1 Ne7 16. Ne3 c6 ' +
  '17. Qf3 Qc7 18. Bd2 Bb6 19. Rad1 Rde8 20. Nd5 cxd5 21. exd5 Nexd5 22. Qg4 Kh7 *';

async function loadAndReview(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(PGN);
  await page.getByRole('button', { name: 'Load PGN' }).click();
  await expect(page.getByTestId('review-panel')).toHaveAttribute('data-status', 'done', {
    timeout: 60_000,
  });
}

test('the tour waits at the opening stop and at the blunder, steps the line and finishes', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await loadAndReview(page);

  const bar = page.getByTestId('review-tour');
  const stop = page.getByTestId('tour-stop');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(/Tour: Stop \d+ of \d+/);
  await expect(bar.getByRole('button', { name: 'Skip to next stop' })).toBeVisible();
  await expect(bar.getByTestId('tour-side')).toBeVisible();

  // Opening stop: waits (no timer), shows the opening and the book move.
  await expect(bar).toHaveAttribute('data-status', 'waiting', { timeout: 30_000 });
  await expect(stop).toHaveAttribute('data-kind', 'opening');
  await expect(stop).toContainText(/Opening:/);
  await expect(stop).toContainText(/Italian|Two Knights|Giuoco/);
  await expect(page.getByTestId('tour-book-move')).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(bar).toHaveAttribute('data-status', 'waiting');
  await expect(stop.getByRole('status')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/review-tour-opening.png`, fullPage: true });

  const axeOpening = await new AxeBuilder({ page })
    .include('[data-testid="review-tour"]')
    .analyze();
  expect(axeOpening.violations).toEqual([]);

  // Continue to the blunder stop of the user's side (switch if the guess was Black).
  await bar.getByTestId('tour-next').click();
  await expect(stop).toHaveAttribute('data-kind', 'mistake', { timeout: 30_000 });
  if (!/Nd5/.test((await stop.textContent()) ?? '')) {
    await bar.getByTestId('tour-side').click();
    await expect(bar).toHaveAttribute('data-status', 'waiting', { timeout: 30_000 });
    if ((await stop.getAttribute('data-kind')) === 'opening') {
      await bar.getByTestId('tour-next').click();
      await expect(stop).toHaveAttribute('data-kind', 'mistake', { timeout: 30_000 });
    }
  }
  await expect(stop).toContainText(/hangs the/);
  await expect(stop).toContainText(/Nd5/);

  // The line steps on the board with the buttons and the ] [ keys.
  const lineStep = page.getByTestId('tour-line-step');
  await expect(lineStep).toContainText(/moves/);
  // The FEN field shows the game position; the line preview moves the pieces on the board.
  const board = page.locator('cg-board');
  const before = await board.innerHTML();
  await stop.getByRole('button', { name: 'Next move of the line' }).click();
  await expect(lineStep).toContainText(/^1\//);
  await expect.poll(() => board.innerHTML()).not.toBe(before);
  await page.keyboard.press(']');
  await expect(lineStep).toContainText(/^2\//);
  await page.keyboard.press('[');
  await expect(lineStep).toContainText(/^1\//);
  await expect(bar).toHaveAttribute('data-status', 'waiting');
  await page.screenshot({ path: `${SHOTS}/review-tour-mistake.png`, fullPage: true });

  const axeMistake = await new AxeBuilder({ page })
    .include('[data-testid="review-tour"]')
    .analyze();
  expect(axeMistake.violations).toEqual([]);

  // Next/Enter run through the remaining stops to the end; the finish text and Replay remain.
  for (let i = 0; i < 8; i++) {
    if ((await bar.getAttribute('data-status')) === 'finished') break;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
  }
  await expect(bar).toHaveAttribute('data-status', 'finished', { timeout: 30_000 });
  await expect(page.getByTestId('review-tour-text')).toContainText(/Tour finished/);
  await expect(bar.getByTestId('tour-replay')).toBeVisible();

  // No Maia without a server: the fallback estimate is labelled approximate.
  await expect(
    page.getByTestId('elo-white').or(page.getByTestId('elo-black')).first(),
  ).toContainText(/approximate/);
});

test('any navigation stops the tour; Replay starts it again', async ({ page }) => {
  test.setTimeout(120_000);
  await loadAndReview(page);
  const bar = page.getByTestId('review-tour');
  await expect(bar).toHaveAttribute('data-status', /playing|waiting/, { timeout: 30_000 });
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowLeft');
  await expect(bar).toHaveAttribute('data-status', 'stopped');
  await expect(page.getByTestId('review-tour-text')).toHaveText('Tour stopped.');
  await bar.getByTestId('tour-replay').click();
  await expect(bar).toHaveAttribute('data-status', /playing|waiting/);
});
