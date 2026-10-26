import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
/** The Evergreen game (Anderssen–Dufresne, Berlin 1852): an Evans Gambit. */
const EVERGREEN =
  '[White "Adolf Anderssen"]\n[Black "Jean Dufresne"]\n\n' +
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. O-O d3 8. Qb3 Qf6 ' +
  '9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8 13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 ' +
  '16. Bxd3 Qh5 17. Nf6+ gxf6 18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 ' +
  '22. Bf5+ Ke8 23. Bd7+ Kf8 24. Bxe7# 1-0';

test('review with opening focus: the Evergreen game leaves the Evans Gambit book at 8. Qb3', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();

  // The ten tabs stay on one line at 1280 px.
  const tops = await page
    .getByRole('tab')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(tops).toHaveLength(10);
  expect(new Set(tops).size).toBe(1);
  // …and all of them are visible without scrolling the row (the 520px panel).
  const row = await page
    .getByRole('tablist', { name: 'Game panels' })
    .evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
  expect(row.sw).toBeLessThanOrEqual(row.cw);

  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(EVERGREEN);
  await page.getByRole('button', { name: 'Load PGN' }).click();
  await expect(page.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByTestId('review-panel');
  await expect(panel).toHaveAttribute('data-status', 'done', { timeout: 90_000 });

  const block = panel.getByRole('region', { name: 'Opening' });
  await expect(block.getByTestId('opening-focus-name')).toContainText('Evans Gambit');
  await expect(block.getByTestId('opening-focus-name')).toContainText('(C52)');
  await expect(block).toContainText('book until move 7 (…d3)');
  await expect(block).toContainText('White continued with 8. Qb3');
  await expect(block).toContainText(/eval [−+]?\d\.\d for White/);

  // The leave move jumps to its ply (after 8. Qb3) and the move card says so.
  await block.getByTestId('opening-focus-leave').click();
  await expect(page.getByLabel('FEN')).toHaveValue(
    /^r1bqk1nr\/pppp1ppp\/2n5\/b7\/2B1P3\/1QPp1N2\/P4PPP\/RNB2RK1 b /,
  );
  await expect(panel.getByTestId('move-card-played')).toContainText('8. Qb3');
  await expect(panel.getByTestId('move-card-book')).toContainText('First move after the book');

  mkdirSync(SHOTS, { recursive: true });
  await block.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/review-opening-focus.png`, fullPage: true });
});
