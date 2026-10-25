import { expect, test } from '@playwright/test';

/**
 * A browser whose WebAssembly lacks SIMD (Playwright's Linux WebKit, older devices): every shipped
 * Stockfish build needs it. Simulated by making `WebAssembly.validate`/`compile`/`instantiate`
 * throw WebKit's `CompileError`. Loading a game starts the auto review, which must end at once
 * with a visible reason (no 30 s handshake timeout, no silent idle panel, no unhandled
 * rejection); the engine picker and the Play tab name the reason too.
 */
const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';
const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';

test('no WebAssembly SIMD: the auto review fails visibly and nothing is cached', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const fail = (): Error => new WebAssembly.CompileError('wasm-simd is not enabled');
    const wa = WebAssembly as unknown as Record<string, unknown>;
    wa.validate = () => {
      throw fail();
    };
    for (const name of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) {
      wa[name] = () => Promise.reject(fail());
    }
    localStorage.setItem('daisychess.settings', JSON.stringify({ reviewTour: false }));
  });
  const pageErrors: string[] = [];
  const unhandled: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (/unhandled/i.test(m.text())) unhandled.push(m.text());
  });

  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();

  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(SCHOLAR);
  const loadedAt = Date.now();
  await page.getByRole('button', { name: 'Load PGN' }).click();

  await expect(page.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByTestId('review-panel');
  await expect(panel).toHaveAttribute('data-status', 'error', { timeout: 10_000 });
  expect(Date.now() - loadedAt).toBeLessThan(10_000);
  await expect(panel.getByRole('alert')).toContainText(
    'Review failed: the browser engine could not start (wasm-simd is not enabled)',
  );
  await expect(panel.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(panel.getByRole('progressbar')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/review-engine-unsupported.png`, fullPage: true });

  // Nothing was stored: loading the same game again reviews (and fails) again, visibly.
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(SCHOLAR);
  await page.getByRole('button', { name: 'Load PGN' }).click();
  await expect(page.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toHaveAttribute('data-status', 'error', { timeout: 10_000 });
  await expect(panel.getByTestId('review-engine')).toHaveCount(0);

  // The engine picker names the reason for every browser build (the live analysis fails at once
  // too, without an unhandled rejection).
  await page.getByRole('switch', { name: 'Engine' }).check();
  await page.getByRole('button', { name: /^Engines/ }).click();
  const picker = page.getByTestId('engine-picker');
  await expect(picker.getByText('This browser lacks WebAssembly SIMD')).toHaveCount(3);

  await page.getByRole('button', { name: /^Engines/ }).click(); // close the picker

  // Play vs Engine says why it cannot start instead of failing mid-game.
  await page.getByRole('tab', { name: 'Play' }).click();
  await expect(page.getByTestId('play-engine-unavailable')).toContainText(
    'This browser lacks WebAssembly SIMD',
  );

  expect(pageErrors).toEqual([]);
  expect(unhandled).toEqual([]);
});
