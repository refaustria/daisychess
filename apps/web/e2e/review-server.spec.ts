import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Game review on the engine server (M17-1, ADR-014): with the review engine on `auto`, a server
 * started with `ACCESS_TOKEN` is not used without the token (the review silently falls back to
 * the browser); after saving the token in Settings the review runs on the server. The server is
 * started by this spec on its own port (8585; 8584 is used by backend.spec and friend.spec).
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
    server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        ALLOWED_ORIGINS: 'http://localhost:4180',
        ACCESS_TOKEN: TOKEN,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForHealth(15_000);
  });

  test.afterAll(async () => {
    await stopServer();
  });

  test('without the token the review falls back to the browser; with it it runs on the server', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
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
    await page.goto('/');
    await expect(page.locator('cg-board')).toBeVisible();

    const loadGame = async (pgn: string) => {
      await page.getByRole('tab', { name: 'Import' }).click();
      await page.getByLabel('PGN text').fill(pgn);
      await page.getByRole('button', { name: 'Load PGN' }).click();
      await expect(page.getByRole('tab', { name: 'Review' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    };
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
});
