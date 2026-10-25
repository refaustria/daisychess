import { expect, test, type Page } from '@playwright/test';

/**
 * Browser engine memory budget (ADR-015): a review followed by a drill shares one batch engine,
 * so at most two Stockfish worker groups (live analysis + the shared engine) exist on a desktop,
 * and one on an iPad (live engine released while paused, threads capped, memory shim).
 */

interface Stats {
  live: number;
  peak: number;
  created: number;
  degraded: boolean;
  pool: { created: number; alive: boolean; holder: string | null; waiting: number };
}

const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';

// Page-side types: the hook is declared in src/engine/devHook.ts.
type Hook = {
  wasmInstances(): Stats;
  resetWasmPeak(): void;
  runReview(o: { pgn: string; movetime: number }): Promise<{ status: string; error?: string }>;
};
const stats = (page: Page): Promise<Stats> =>
  page.evaluate(() => (window as unknown as { __chesslab: Hook }).__chesslab.wasmInstances());

async function squareCentre(page: Page, sq: string) {
  const box = await page.locator('cg-board').boundingBox();
  if (!box) throw new Error('cg-board has no box');
  const s = box.width / 8;
  return {
    x: box.x + (sq.charCodeAt(0) - 97 + 0.5) * s,
    y: box.y + (7 - (Number(sq[1]) - 1) + 0.5) * s,
  };
}

async function move(page: Page, from: string, to: string, turn: 'w' | 'b') {
  for (const sq of [from, to]) {
    const p = await squareCentre(page, sq);
    await page.mouse.click(p.x, p.y);
  }
  await expect(page.getByLabel('FEN')).toHaveValue(new RegExp(` ${turn} `), { timeout: 5_000 });
}

/** Live analysis on, a review, then a drill with one engine check. */
async function reviewThenDrill(page: Page, threads?: RegExp): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('switch', { name: 'Engine' }).check();
  await expect(page.getByTestId('engine-status')).toHaveText(/depth \d+/, { timeout: 30_000 });
  if (threads) await expect(page.getByTestId('engine-status')).toHaveText(threads);

  const review = await page.evaluate(
    (pgn) =>
      (window as unknown as { __chesslab: Hook }).__chesslab.runReview({ pgn, movetime: 100 }),
    SCHOLAR,
  );
  expect(review.status, review.error).toBe('done');

  await page.getByRole('tab', { name: 'Openings' }).click();
  await page.getByRole('searchbox', { name: 'Search openings' }).fill('Italian');
  await page.getByRole('list', { name: 'Openings' }).getByRole('button').first().click();
  await page.getByRole('radio', { name: 'Drill' }).check({ force: true });
  await page.getByRole('radio', { name: 'White' }).check({ force: true });
  await page.getByRole('button', { name: 'Start drill' }).click();
  const feedback = page.getByTestId('drill-feedback');
  await expect(feedback).toContainText('You play White');
  await move(page, 'e2', 'e4', 'b');
  await expect(feedback).toContainText('Book reply e5', { timeout: 5_000 });
  await move(page, 'f1', 'a6', 'b');
  await expect(feedback).toContainText(/Mistake: Ba6 loses/, { timeout: 45_000 });
}

test.describe('browser engine memory budget', () => {
  test.setTimeout(150_000);

  test('desktop: review + drill + live analysis use at most 2 engine instances', async ({ page }) => {
    await reviewThenDrill(page);
    const s = await stats(page);
    console.log('desktop wasm instances', JSON.stringify(s));
    expect(s.peak).toBeLessThanOrEqual(2);
    // The live engine and one shared batch engine for the review and the drill.
    expect(s.created).toBe(2);
    expect(s.pool.created).toBe(1);
    expect(s.degraded).toBe(false);
  });

  test.describe('iPad', () => {
    test.use({
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      hasTouch: true,
    });

    test('one engine instance at a time, 2 threads, capped shared memory', async ({ page }) => {
      await reviewThenDrill(page, /\b2 threads\b/);
      const s = await stats(page);
      console.log('iPad wasm instances', JSON.stringify(s));
      expect(s.peak).toBe(1);
      const shim = page.workers().filter((w) => w.url().includes('stockfish-memory-shim.js'));
      expect(shim.length).toBeGreaterThan(0);
      // The group's first worker is the engine (pthreads block in Atomics.wait; skip them).
      const maxima = await Promise.all(
        shim.map((w) =>
          Promise.race([
            w.evaluate(
              () =>
                (self as unknown as { __chesslabMemory?: { maximum: number } }).__chesslabMemory
                  ?.maximum ?? null,
            ),
            new Promise<null>((r) => setTimeout(() => r(null), 1_000)),
          ]).catch(() => null),
        ),
      );
      expect(maxima).toContain(8192);
    });
  });
});
