import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
const MATE_IN_1 = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const LABEL = /^[+-]?\d+\.\d+$|^-?M\d+$/;

async function drag(page: Page, from: string, to: string) {
  const box = (await page.locator('cg-board').boundingBox())!;
  const s = box.width / 8;
  const at = (sq: string) => ({
    x: box.x + (sq.charCodeAt(0) - 97 + 0.5) * s,
    y: box.y + (8 - Number(sq[1]) + 0.5) * s,
  });
  const a = at(from);
  const b = at(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}

test.describe('live analysis', () => {
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('chesslab.analysis'));
    await page.reload();
    await expect(page.locator('cg-board')).toBeVisible();
  });

  test('engine toggle drives the eval bar; mate in 1 shows M1', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const bar = page.getByTestId('eval-bar');
    const label = page.getByTestId('eval-label');

    // Disabled: neutral bar, no label; bar is as tall as the board, board stays square.
    await expect(bar).toHaveAttribute('aria-label', 'Evaluation unavailable');
    await expect(label).toHaveCount(0);
    // The board element (chessground snaps cg-board to a multiple of 8 px inside it).
    const board = (await page.getByTestId('board').boundingBox())!;
    const barBox = (await bar.boundingBox())!;
    expect(Math.abs(board.width - board.height)).toBeLessThan(2);
    expect(Math.abs(barBox.height - board.height)).toBeLessThan(2);
    expect(barBox.x + barBox.width).toBeLessThanOrEqual(board.x);

    await page.getByRole('switch', { name: 'Engine' }).check();
    await expect(label).toHaveText(LABEL, { timeout: 20_000 });
    await expect(page.getByTestId('engine-status')).toHaveText(/thread/);
    await expect(bar).toHaveAttribute('aria-label', /^Evaluation /);

    await drag(page, 'e2', 'e4');
    // chessground dispatches its `move` event via setTimeout, so the FEN updates asynchronously
    // (later still while the engine keeps the CPU busy): wait for it instead of reading it once.
    const fenInput = page.getByLabel('FEN');
    await expect(fenInput).toHaveValue(/4P3/);
    const fen = await fenInput.inputValue();
    await expect(bar).toHaveAttribute('data-fen', fen);
    await expect(label).toHaveText(LABEL, { timeout: 20_000 });
    await expect(page.getByTestId('engine-status')).toHaveText(/depth \d+/);

    await page.getByRole('tab', { name: 'Import' }).click();
    await page.getByLabel('Position to import').fill(MATE_IN_1);
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await expect(bar).toHaveAttribute('data-fen', MATE_IN_1);
    await expect(label).toHaveText('M1', { timeout: 20_000 });
    await expect(bar).toHaveAttribute('aria-label', 'Evaluation M1');
    // Label sits at White's end (bottom) for a White advantage.
    const lb = (await label.boundingBox())!;
    const bb = (await bar.boundingBox())!;
    expect(lb.y).toBeGreaterThan(bb.y + bb.height / 2);

    await expect(bar).toHaveAttribute('data-share', '98.0');
    await page.waitForTimeout(400); // let the 300 ms height transition finish
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/analysis.png`, fullPage: true });

    // Persisted: still enabled after a reload.
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Engine' })).toBeChecked();
    await expect(label).toHaveText(LABEL, { timeout: 20_000 });

    await page.getByRole('switch', { name: 'Engine' }).uncheck();
    await expect(label).toHaveCount(0);
    await expect(page.getByTestId('engine-status')).toHaveText('Off');
    expect(errors).toEqual([]);
  });

  test('rapid keyboard navigation follows the position without runaway searches', async ({
    page,
  }) => {
    // Count `go` commands vs `bestmove` replies at the Worker boundary.
    await page.addInitScript(() => {
      // Only the live analysis may search here: no automatic review after loading the PGN.
      localStorage.setItem('chesslab.settings', JSON.stringify({ autoReview: false }));
      const Orig = window.Worker;
      const stats = { go: 0, bestmove: 0, maxOpen: 0 };
      (window as unknown as { __uciStats: typeof stats }).__uciStats = stats;
      window.Worker = class extends Orig {
        constructor(url: string | URL, opts?: WorkerOptions) {
          super(url, opts);
          this.addEventListener('message', (e: MessageEvent) => {
            if (typeof e.data === 'string' && e.data.startsWith('bestmove')) stats.bestmove++;
          });
        }
        postMessage(msg: unknown, ...rest: unknown[]) {
          if (typeof msg === 'string' && msg.startsWith('go')) {
            stats.go++;
            stats.maxOpen = Math.max(stats.maxOpen, stats.go - stats.bestmove);
          }
          // @ts-expect-error -- forwarding the overloads unchanged
          super.postMessage(msg, ...rest);
        }
      };
    });
    await page.reload();
    await page.getByRole('tab', { name: 'Import' }).click();
    await page
      .getByLabel('PGN text')
      .fill(
        '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7',
      );
    await page.getByRole('button', { name: 'Load PGN' }).click();
    await page.getByRole('switch', { name: 'Engine' }).check();
    const label = page.getByTestId('eval-label');
    await expect(label).toHaveText(LABEL, { timeout: 20_000 });

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
    // 20 plies from the start: 10... Nbd7 is the last move.
    await expect(page.getByLabel('FEN')).toHaveValue(/^r1bq1rk1\//);
    const fen = await page.getByLabel('FEN').inputValue();
    await expect(page.getByTestId('eval-bar')).toHaveAttribute('data-fen', fen);
    await expect(label).toHaveText(LABEL, { timeout: 20_000 });
    const stats = await page.evaluate(
      () =>
        (window as unknown as { __uciStats: { go: number; bestmove: number; maxOpen: number } })
          .__uciStats,
    );
    expect(stats.maxOpen).toBeLessThanOrEqual(2);
    // Debounced: far fewer searches than navigation steps.
    expect(stats.go).toBeLessThan(10);
  });
});

test('analysis panel: MultiPV lines in SAN, hover arrows, click preview', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('chesslab.analysis'));
  await page.reload();
  await page.getByRole('switch', { name: 'Engine' }).check();
  const panel = page.getByTestId('analysis-panel');
  await expect(panel).toBeVisible();
  await page.getByLabel('Lines').selectOption('3');

  const lines = page.getByTestId('analysis-line');
  await expect(lines).toHaveCount(3, { timeout: 20_000 });
  for (let i = 0; i < 3; i++) {
    await expect(lines.nth(i).getByTestId('analysis-eval')).toHaveText(LABEL, { timeout: 20_000 });
    await expect(lines.nth(i).getByTestId('analysis-pv')).toHaveText(
      /^1\. [KQRBN]?[a-h]?[1-8]?x?[a-h][1-8]/,
      {
        timeout: 20_000,
      },
    );
  }

  // Best-move arrow (green) while idle.
  const shapes = page.locator('.cg-shapes g');
  await expect.poll(() => shapes.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  const before = await page.locator('.cg-shapes').innerHTML();
  await lines.nth(1).hover();
  await expect
    .poll(async () => page.locator('.cg-shapes').innerHTML(), { timeout: 5_000 })
    .not.toBe(before);
  expect(await shapes.count()).toBeGreaterThanOrEqual(1);

  const fenInput = page.getByLabel('FEN');
  const fen = await fenInput.inputValue();
  await lines.nth(0).click();
  const banner = page.getByTestId('preview-banner');
  await expect(banner).toBeVisible();
  await expect(page.getByTestId('board')).toHaveAttribute('data-preview', 'true');
  await expect(fenInput).toHaveValue(fen);
  await page.waitForTimeout(400);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/analysis-panel.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await expect(banner).toHaveCount(0);
  await expect(fenInput).toHaveValue(fen);
});
