import { expect, test, type Page } from '@playwright/test';

const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';

interface Result {
  status: string;
  error?: string;
  ms: number;
  summary?: {
    white: { accuracy: number };
    black: { accuracy: number };
    moves: { san?: string; uci: string; classification: string; bestMove?: string }[];
  };
}

function runReview(
  page: Page,
  opts: { pgn: string; movetime?: number; depth?: number },
): Promise<Result> {
  // Page-side types: the hook is declared in src/engine/devHook.ts / src/review/reviewDevHook.ts.
  return page.evaluate(
    (o) =>
      (
        window as unknown as { __chesslab: { runReview(x: typeof o): Promise<Result> } }
      ).__chesslab.runReview(o),
    opts,
  );
}

function expectScholarReview(r: Result): void {
  expect(r.status, r.error).toBe('done');
  const s = r.summary!;
  expect(s.moves).toHaveLength(7);
  expect(s.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']);
  expect(['blunder', 'mistake']).toContain(s.moves[5]!.classification);
  expect(s.moves[6]!.classification).toBe('best');
  for (const side of [s.white, s.black]) {
    expect(side.accuracy).toBeGreaterThanOrEqual(0);
    expect(side.accuracy).toBeLessThanOrEqual(100);
  }
}

test.describe('game review (batch analysis)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('cg-board')).toBeVisible();
  });

  test("Scholar's mate at 200 ms/move", async ({ page }) => {
    test.setTimeout(60_000);
    const t0 = Date.now();
    const r = await runReview(page, { pgn: SCHOLAR, movetime: 200 });
    const total = Date.now() - t0;
    console.log(`review movetime 200: ${r.ms} ms (incl. engine load), evaluate ${total} ms`);
    expectScholarReview(r);
    expect(total).toBeLessThan(20_000);
  });

  test("Scholar's mate at depth 18", async ({ page }) => {
    test.setTimeout(120_000);
    const r = await runReview(page, { pgn: SCHOLAR, depth: 18 });
    console.log(`review depth 18: ${r.ms} ms (incl. engine load)`);
    expectScholarReview(r);
  });
});
