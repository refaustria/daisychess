import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * Game review on the engine server (M17-1, ADR-014): with the review engine on `auto`, a server
 * started with `ACCESS_TOKEN` is not used without the token (the review silently falls back to
 * the browser); after saving the token in Settings the review runs on the server. The server is
 * started by this spec on its own port (8585; 8584 is used by backend.spec and friend.spec).
 *
 * Server review store (M20-3, ADR-017): the server keeps the finished review in its SQLite store
 * (a temporary file for this spec), so after the local cache is cleared the same game is "Loaded
 * from server" without a run, also in a browser context that has no token.
 */
const PORT = 8585;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const TOKEN = 'e2e-review-secret-token';
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ENTRY = `${REPO}apps/server/dist/index.js`;
const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
const GAME = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6';
// A different game for the server run: the review cache would answer GAME without a search.
const GAME2 = '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 h6 7. Bh4 b6';

let server: ChildProcess | null = null;
let storeDir: string | null = null;

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

test.describe('game review on the server', () => {
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
    storeDir = mkdtempSync(join(tmpdir(), 'daisychess-review-store-'));
    server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        ALLOWED_ORIGINS: 'http://localhost:4180',
        ACCESS_TOKEN: TOKEN,
        // The review store (ADR-017) lives in a fresh temporary file for this spec.
        REVIEW_STORE_PATH: join(storeDir, 'reviews.sqlite'),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForHealth(15_000);
  });

  test.afterAll(async () => {
    await stopServer();
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
    storeDir = null;
  });

  test('without the token the review falls back to the browser; with it it runs on the server', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await pointAtServer(page);
    await page.goto('/');
    await expect(page.locator('cg-board')).toBeVisible();

    const loadGame = (pgn: string) => loadPgn(page, pgn);
    const panel = page.getByTestId('review-panel');

    // No token: auto review (fast) falls back to the browser.
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByTestId('review-engine-select')).toHaveValue('auto');
    await loadGame(GAME);
    await expect(panel).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
    // Auto + no/wrong token: silent fallback (no notice).
    await expect(panel.getByTestId('review-engine')).toHaveText('Reviewed in browser.');
    await expect(panel.getByTestId('review-engine-notice')).toHaveCount(0);

    // Token saved in Settings: the next review runs on the server.
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByLabel('Server access token').fill(TOKEN);
    await page.getByRole('button', { name: 'Save token' }).click();
    await loadGame(GAME2);
    await expect(panel).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
    await expect(panel.getByTestId('review-engine')).toHaveText(
      /^Reviewed on server \(.+, \d+ threads?\)\.$/,
    );
    await expect(panel.getByTestId('review-engine')).toHaveAttribute('data-engine', 'server');
    await expect(panel.getByTestId('review-engine-notice')).toHaveCount(0);
    await expect(panel.getByTestId('accuracy-white')).toHaveText(/\d+%/);
    expect(await panel.locator('[data-point]').count()).toBeGreaterThanOrEqual(14);

    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/review-server.png`, fullPage: true });
    expect(errors).toEqual([]);
  });

  test('the review is kept on the server: shown after clearing the local cache and in a browser without the token', async ({
    page,
    browser,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await pointAtServer(page);
    await page.goto('/');
    await expect(page.locator('cg-board')).toBeVisible();
    const panel = page.getByTestId('review-panel');

    // Same browser as the previous test would be ideal, but every test gets a fresh context: set
    // the token, make sure GAME2 is stored on the server (reviewed there in the previous test; if
    // this test runs alone the review runs on the server now and is stored), then drop the cache.
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByLabel('Server access token').fill(TOKEN);
    await page.getByRole('button', { name: 'Save token' }).click();
    await loadPgn(page, GAME2);
    await expect(panel).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
    await expect(panel.getByTestId('review-engine')).toHaveText(/server/);
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByTestId('review-cache-server')).toHaveText(
      /^Server: \d+ reviews? · [\d.]+ (B|kB|MB|GB) of [\d.]+ (MB|GB)$/,
    );
    const clear = page.getByRole('button', { name: 'Clear cache' });
    await expect(clear).toBeEnabled();
    await clear.click();
    await expect(page.getByTestId('review-cache-count')).toHaveText('0 stored reviews');

    await page.reload();
    await expect(page.locator('cg-board')).toBeVisible();
    await watchForRun(page);
    await loadPgn(page, GAME2);
    await expect(panel).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
    await expect(panel.getByTestId('review-engine')).toHaveText(
      /^Loaded from server \(reviewed \d{1,2} [A-Z][a-z]{2}, (fast|deep)\)$/,
    );
    await expect(panel.getByTestId('accuracy-white')).toHaveText(/\d+%/);
    await expect(panel.getByRole('progressbar')).toHaveCount(0);
    expect(await sawRun(page)).toBe(false);
    expect(errors).toEqual([]);

    // A second browser context without the token (reads are open to everyone).
    const guest = await browser.newContext();
    const other = await guest.newPage();
    const otherErrors: string[] = [];
    other.on('pageerror', (e) => otherErrors.push(e.message));
    await pointAtServer(other);
    await other.goto('/');
    await expect(other.locator('cg-board')).toBeVisible();
    await watchForRun(other);
    await loadPgn(other, GAME2);
    const otherPanel = other.getByTestId('review-panel');
    await expect(otherPanel).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
    await expect(otherPanel.getByTestId('review-engine')).toHaveText(/^Loaded from server /);
    await expect(otherPanel.getByRole('progressbar')).toHaveCount(0);
    expect(await sawRun(other)).toBe(false);
    expect(otherErrors).toEqual([]);
    await guest.close();
  });
});

/** Points the app at the spec's engine server (analysis settings in localStorage). */
async function pointAtServer(page: Page): Promise<void> {
  await page.addInitScript(
    ({ url }) => {
      if (!localStorage.getItem('daisychess.analysis')) {
        localStorage.setItem(
          'daisychess.analysis',
          JSON.stringify({ enabled: false, settings: { depth: 12, multipv: 1, remoteUrl: url } }),
        );
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

/** Records whether a progress bar or a running review ever shows up from now on. */
async function watchForRun(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __sawRun: boolean };
    w.__sawRun = false;
    new MutationObserver(() => {
      if (
        document.querySelector('[role="progressbar"][aria-label="Review progress"]') ||
        document.querySelector('[data-testid="review-panel"][data-status="running"]')
      ) {
        w.__sawRun = true;
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-status'],
    });
  });
}

function sawRun(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __sawRun: boolean }).__sawRun);
}
