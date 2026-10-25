import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * Human-like review hints (M23-3, ADR-019): with the server access token the review of a game
 * between two ~1500 players shows, at the blunder 3... Nf6??, what Maia 1500 would play there.
 * Needs the real Lc0 build and the Maia nets (`pnpm build-lc0`, `pnpm fetch-engines`); skipped
 * otherwise. The engine server is started by this spec on its own port (8588).
 */
const PORT = 8588;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const TOKEN = 'e2e-maia-secret-token';
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ENTRY = `${REPO}apps/server/dist/index.js`;
const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
const APP_ORIGIN = `http://localhost:${process.env.E2E_PORT ?? 4180}`;
const GAME =
  '[Event "Casual"]\n[White "Ann"]\n[Black "Bob"]\n[WhiteElo "1487"]\n[BlackElo "1512"]\n\n' +
  '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';

function lc0Available(): boolean {
  if (process.env.SKIP_LC0 === '1') return false;
  try {
    accessSync(`${REPO}engines/lc0/lc0`, constants.X_OK);
    accessSync(`${REPO}engines/maia/maia-1500.pb.gz`, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

let server: ChildProcess | null = null;

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null)
      throw new Error(`engine server exited with code ${server?.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`engine server did not become healthy: ${String(last)}`);
}

/** Stops the server this spec started (by its handle, never by name). */
async function stopServer(): Promise<void> {
  const proc = server;
  server = null;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.kill('SIGTERM');
  const timer = setTimeout(() => proc.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(timer);
}

test.describe('human-like review hints (Maia)', () => {
  test.skip(!lc0Available(), 'Lc0 + Maia not installed (pnpm build-lc0 && pnpm fetch-engines)');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    if (!existsSync(SERVER_ENTRY) || !existsSync(`${REPO}packages/engine-core/dist/index.js`)) {
      execSync(
        'pnpm --filter @daisychess/engine-core build && pnpm --filter @daisychess/server build',
        { cwd: REPO, stdio: 'inherit' },
      );
    }
    server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        ALLOWED_ORIGINS: APP_ORIGIN,
        ACCESS_TOKEN: TOKEN,
        REVIEW_STORE: 'off',
        MAIA: 'on',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForHealth(15_000);
  });

  test.afterAll(stopServer);

  test('without the token one muted line; with it the blunder shows what 1500 players play', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await setup(page);
    await page.goto('/');
    await expect(page.locator('cg-board')).toBeVisible();
    const panel = page.getByTestId('review-panel');

    // No token: the review falls back to the browser, the hints only leave one muted line.
    await loadPgn(page, GAME);
    await expect(panel).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
    await expect(panel.getByTestId('maia-token-note')).toHaveText(
      'Human-like hints need the server access token — enter it in Settings',
      { timeout: 15_000 },
    );
    await expect(panel.getByTestId('move-card-maia')).toHaveCount(0);

    // Token saved: the next review (the same game, from the cache) gets the hints.
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByLabel('Server access token').fill(TOKEN);
    await page.getByRole('button', { name: 'Save token' }).click();
    await expect(page.getByLabel('Your level for human-like hints')).toHaveValue('1500');
    await page.getByRole('tab', { name: 'Review' }).click();
    await expect(panel).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
    await expect(panel.getByTestId('maia-token-note')).toHaveCount(0, { timeout: 15_000 });

    // Jump to 3... Nf6?? (the blunder) and wait for Maia 1500's answer.
    await panel.getByRole('button', { name: /3\.\.\. Nf6\?\?/ }).first().click();
    await expect(panel.getByTestId('move-card-played')).toHaveText('3... Nf6??');
    const hint = panel.getByTestId('move-card-maia');
    await expect(hint).toContainText(/at 1500/i, { timeout: 30_000 });
    await expect(hint).toHaveText(
      /^(At 1500, \d+% would play \S+ here \(Nf6\?\? in the game: (<?\d+%|under <?\d+%|rare)\)\.|A very common blunder at 1500: \d+% of players play this\.)/,
    );
    await expect(hint).toHaveAttribute('title', 'Maia 1500 — from the PGN rating 1512');
    await expect(panel.getByTestId('maia-summary-black')).toHaveText(
      /^Bob at 1500: [01] typical, [01] unusual$/,
    );

    test.info().annotations.push({ type: 'maia-hint', description: await hint.innerText() });
    await hint.scrollIntoViewIfNeeded();
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/review-maia.png` });
    expect(errors).toEqual([]);
  });
});

/** Points the app at the spec's engine server and turns the guided tour off. */
async function setup(page: Page): Promise<void> {
  await page.addInitScript(
    ({ url }) => {
      if (!localStorage.getItem('daisychess.analysis')) {
        localStorage.setItem(
          'daisychess.analysis',
          JSON.stringify({ enabled: false, settings: { depth: 12, multipv: 1, remoteUrl: url } }),
        );
      }
      if (!localStorage.getItem('daisychess.settings')) {
        localStorage.setItem('daisychess.settings', JSON.stringify({ reviewTour: false }));
      }
    },
    { url: WS_URL },
  );
}

async function loadPgn(page: Page, pgn: string): Promise<void> {
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(pgn);
  await page.getByRole('button', { name: 'Load PGN' }).click();
  await expect(page.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true');
}
