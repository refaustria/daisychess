import { expect, test } from '@playwright/test';

// Morphy - Duke of Brunswick & Count Isouard, 1858 (Opera game).
const OPERA =
  '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 ' +
  '9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 ' +
  '15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8#';

test('navigation stays responsive while the engine streams 5 lines', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(OPERA);
  await page.getByRole('button', { name: 'Load PGN' }).click();
  await page.getByRole('switch', { name: 'Engine' }).check();
  await expect(page.getByTestId('engine-status')).toContainText(/depth \d+/, { timeout: 30_000 });
  await page.getByLabel('Lines').selectOption('5');
  await expect(page.locator('[data-multipv="5"]')).toBeVisible({ timeout: 30_000 });

  await page.evaluate(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => w.__long.push(e.duration)),
    ).observe({
      entryTypes: ['longtask'],
    });
  });
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  const ms = await page.evaluate(async () => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: i % 40 < 20 ? 'ArrowLeft' : 'ArrowRight' }),
      );
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    return performance.now() - t0;
  });
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  const worst = Math.max(0, ...long);
  test.info().annotations.push({
    type: 'perf',
    description: `200 key presses in ${ms.toFixed(0)} ms, ${long.length} long tasks, worst ${worst.toFixed(0)} ms`,
  });
  // 200 ms when run alone (measured 65 ms); looser here because specs run in parallel with other engines.
  expect(worst).toBeLessThan(400);
});
