import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { Chess } from 'chess.js';

/** Starter rows: [id, fen, 'uci uci …', rating, rd, themeIdx, openingIdx, game]. */
type Row = [string, string, string, number, number, number[], number[], string];
const starter = JSON.parse(
  readFileSync(new URL('../src/puzzles/data/starter.json', import.meta.url), 'utf8'),
) as { rows: Row[] };

/** SAN of the user's moves (moves[1], moves[3], …) of a starter puzzle. */
function userSans(id: string): string[] {
  const row = starter.rows.find((r) => r[0] === id);
  if (!row) throw new Error(`puzzle ${id} is not in the starter`);
  const chess = new Chess(row[1]);
  const out: string[] = [];
  row[2].split(' ').forEach((uci, i) => {
    const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    if (i % 2 === 1) out.push(m.san);
  });
  return out;
}

test('puzzles: solve a starter puzzle with the typed move input, the rating changes', async ({
  page,
}) => {
  test.setTimeout(60_000);
  // No puzzle server: the data layer falls back to the bundled starter set.
  await page.route('**/puzzles/v1/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Puzzles' }).click();

  const rating = page.getByTestId('puzzle-rating');
  await expect(rating).toContainText('Puzzle rating 1500 ± 350');
  await expect(page.getByText('Puzzles from the lichess.org database (CC0)')).toBeVisible();

  await page.getByRole('button', { name: 'Start puzzles' }).click();
  const status = page.getByTestId('puzzle-status');
  await expect(status).toContainText('Your turn', { timeout: 15_000 });
  const meta = await page.getByTestId('puzzle-meta').textContent();
  const id = /Puzzle (\S+)/.exec(meta ?? '')?.[1];
  expect(id).toBeTruthy();

  // No serious/critical accessibility violations in the running puzzle panel.
  const { violations } = await new AxeBuilder({ page }).include('#tabpanel-main').analyze();
  expect(
    violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id),
  ).toEqual([]);

  const input = page.getByLabel('Move, e.g. Nf3');
  const sans = userSans(id!);
  for (const [i, san] of sans.entries()) {
    await expect(input).toBeEnabled({ timeout: 5_000 });
    await input.fill(san);
    await input.press('Enter');
    if (i < sans.length - 1) await expect(status).toContainText('Find the next move');
  }
  await expect(status).toHaveText('Solved!');
  await expect(rating).not.toContainText('1500 ± 350');
  await expect(page.getByTestId('puzzle-rating-delta')).toContainText('+');
  await expect(page.getByRole('link', { name: 'Source game' })).toHaveAttribute(
    'href',
    /^https:\/\/lichess\.org\//,
  );

  // Analyse: the line stays on the board, the Moves tab opens.
  await page.getByRole('button', { name: 'Analyse' }).click();
  await expect(page.getByRole('tab', { name: 'Moves' })).toHaveAttribute('aria-selected', 'true');
});
