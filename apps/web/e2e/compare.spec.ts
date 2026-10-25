import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Multi-engine comparison (M5-1): the browser engine and a server engine analyse the same
 * position side by side (tabs + compare strip). The server is started by this spec on its own
 * port (8583).
 */
const PORT = 8583;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ENTRY = `${REPO}apps/server/dist/index.js`;
const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
const LABEL = /^[+-]?\d+\.\d+$|^-?M\d+$/;

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

test.describe('multi-engine comparison', () => {
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
        MAX_SESSIONS: '4',
        LOG_LEVEL: 'warn',
        // The preview page (localhost:4180) connects cross-origin.
        ALLOWED_ORIGINS: 'http://localhost:4180',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForHealth(15_000);
  });

  test.afterAll(async () => {
    await stopServer();
  });

  test('browser + server engine side by side: tabs, compare strip, disable one', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(
      ({ url }) => {
        const key = 'daisychess.analysis';
        if (!localStorage.getItem(key)) {
          localStorage.setItem(
            key,
            JSON.stringify({ enabled: false, settings: { depth: 16, multipv: 2, remoteUrl: url } }),
          );
        }
      },
      { url: WS_URL },
    );
    await page.goto('/');
    await expect(page.locator('cg-board')).toBeVisible();

    await page.getByRole('switch', { name: 'Engine' }).check();
    await expect(page.getByTestId('eval-label')).toHaveText(LABEL, { timeout: 30_000 });
    // Single engine: the panel looks as before (no tabs, no compare strip).
    await expect(page.getByTestId('engine-tab')).toHaveCount(0);
    await expect(page.getByTestId('compare-strip')).toHaveCount(0);

    // Enable the server engine next to the browser engine.
    await page.getByRole('button', { name: /^Engines/ }).click();
    const picker = page.getByTestId('engine-picker');
    await picker
      .getByRole('checkbox', { name: /Stockfish 19 \(server\)/ })
      .check({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);

    const tabs = page.getByTestId('engine-tab');
    await expect(tabs).toHaveCount(2);
    await expect(page.getByTestId('compare-chip')).toHaveCount(2);
    const evals = page.getByTestId('compare-eval');
    await expect(evals).toHaveCount(2, { timeout: 20_000 });
    await expect(evals.nth(0)).toHaveText(LABEL);
    await expect(evals.nth(1)).toHaveText(LABEL);
    await expect(page.getByTestId('compare-chip').nth(0)).toContainText('browser');
    await expect(page.getByTestId('compare-chip').nth(1)).toContainText('server');

    // First tab: browser engine.
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('backend-badge')).toHaveText('Browser');
    await expect(page.getByTestId('analysis-line').first()).toBeVisible();
    const browserMeta = await page.getByTestId('analysis-meta').textContent();

    // Second tab: the server engine's lines.
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('engine-tabpanel')).toHaveAttribute(
      'data-engine',
      'remote:stockfish',
    );
    await expect(page.getByTestId('backend-badge')).toHaveText('Server');
    await expect(page.getByTestId('analysis-line').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('analysis-meta')).not.toHaveText(browserMeta ?? '');
    await expect(page.getByTestId('analysis-meta')).toContainText('depth');

    await page.waitForTimeout(300);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/compare.png`, fullPage: true });

    // Disable the server engine: back to a single engine without tabs.
    await page.getByRole('button', { name: /^Engines/ }).click();
    await picker.getByRole('checkbox', { name: /Stockfish 19 \(server\)/ }).uncheck();
    await page.keyboard.press('Escape');
    await expect(tabs).toHaveCount(0);
    await expect(page.getByTestId('compare-strip')).toHaveCount(0);
    await expect(page.getByTestId('backend-badge')).toHaveText('Browser');
    await expect(page.getByTestId('analysis-line').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('eval-label')).toHaveText(LABEL);

    // Persisted selection: one engine after a reload.
    await page.reload();
    await expect(page.getByTestId('eval-label')).toHaveText(LABEL, { timeout: 30_000 });
    await expect(tabs).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
