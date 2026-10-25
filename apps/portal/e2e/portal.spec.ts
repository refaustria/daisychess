import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Operator portal end to end: the built SPA (vite preview, /api/portal proxied to the hub) against
 * a real ROLE=hub server started here on its own port. lichess is faked on both sides: the browser
 * side (oauth page, token endpoint) with page.route, the hub side (GET /api/account through
 * PORTAL_LICHESS_PROXY) with a tiny local HTTP server. Nothing talks to lichess.org.
 */
const WEB_PORT = Number(process.env.PORTAL_E2E_PORT ?? 4190);
const HUB_PORT = Number(process.env.PORTAL_E2E_HUB_PORT ?? 8591);
const LICHESS_PORT = Number(process.env.PORTAL_E2E_LICHESS_PORT ?? 8593);
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ENTRY = `${REPO}apps/server/dist/index.js`;
const LICHESS_TOKEN = 'lio_e2e_access_token';
const SHOT_DIR = fileURLToPath(new URL('../test-results/', import.meta.url));

let hub: ChildProcess | null = null;
let fakeLichess: Server | null = null;
let dataDir = '';
const accountCalls: (string | undefined)[] = [];

test.beforeAll(async () => {
  if (!existsSync(SERVER_ENTRY)) throw new Error('apps/server/dist missing: run `pnpm build` first');
  fakeLichess = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/account') {
      accountCalls.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${LICHESS_TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'e2eoperator', username: 'E2EOperator' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => fakeLichess!.listen(LICHESS_PORT, '127.0.0.1', r));

  dataDir = mkdtempSync(join(tmpdir(), 'daisychess-portal-e2e-'));
  mkdirSync(dataDir, { recursive: true });
  hub = spawn('node', [SERVER_ENTRY], {
    cwd: dataDir,
    env: {
      ...process.env,
      ROLE: 'hub',
      HOST: '127.0.0.1',
      PORT: String(HUB_PORT),
      HUB_STORE_PATH: join(dataDir, 'hub.db'),
      REVIEW_STORE: 'off',
      MAIA: 'off',
      PUBLIC_ORIGIN: `http://localhost:${WEB_PORT}`,
      PORTAL_LICHESS_PROXY: `http://127.0.0.1:${LICHESS_PORT}/`,
      HUB_ADMIN_LICHESS: 'e2eoperator',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (hub.exitCode !== null) throw new Error(`hub exited with code ${hub.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${HUB_PORT}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('hub did not become healthy');
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(async () => {
  // Only the processes started above.
  hub?.kill('SIGTERM');
  await new Promise<void>((r) => (fakeLichess ? fakeLichess.close(() => r()) : r()));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test('login, create a node and a token, see the setup link, revoke the token', async ({ page }) => {
  const revoked: (string | undefined)[] = [];
  // The preview server sends the production CSP: any violation shows up as a console error.
  const cspErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) cspErrors.push(m.text());
  });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'POST,DELETE,OPTIONS' };

  // lichess consent page: approve at once and send the browser back to the redirect_uri.
  await page.route('https://lichess.org/oauth?**', async (route) => {
    const q = new URL(route.request().url()).searchParams;
    expect(q.get('client_id')).toBe('daisychess-portal.c.referee.at');
    expect(q.get('code_challenge_method')).toBe('S256');
    const back = new URL(q.get('redirect_uri')!);
    back.searchParams.set('code', 'e2e-code');
    back.searchParams.set('state', q.get('state')!);
    await route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  await page.route('https://lichess.org/api/token', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (req.method() === 'DELETE') {
      revoked.push(await req.headerValue('authorization') ?? undefined);
      return route.fulfill({ status: 204, headers: cors });
    }
    expect(req.postData()).toContain('code=e2e-code');
    expect(req.postData()).toContain('code_verifier=');
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ token_type: 'Bearer', access_token: LICHESS_TOKEN, expires_in: 3600 }) });
  });

  await page.goto('/portal/');
  await page.getByRole('button', { name: 'Log in with lichess' }).click();
  await expect(page.getByRole('heading', { name: 'Nodes' })).toBeVisible();
  await expect(page.getByText('E2EOperator')).toBeVisible();
  // the hub saw the lichess token once; lichess was told to forget it; the URL is clean
  expect(accountCalls).toEqual([`Bearer ${LICHESS_TOKEN}`]);
  await expect.poll(() => revoked).toEqual([`Bearer ${LICHESS_TOKEN}`]);
  expect(new URL(page.url()).search).toBe('');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(LICHESS_TOKEN);

  // Nodes: create
  await expect(page.getByText(/No nodes yet/)).toBeVisible();
  await page.getByRole('button', { name: 'Create node' }).click();
  await page.getByLabel(/^Name/).fill('e2e-node');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  const nodeDialog = page.getByRole('dialog', { name: /e2e-node created/ });
  const nodeToken = (await nodeDialog.getByLabel('Node token', { exact: true }).textContent())!;
  expect(nodeToken).toMatch(/^dcn_[A-Za-z0-9]+_[A-Za-z0-9]+$/);
  await expect(nodeDialog.getByLabel('docker-compose.yml', { exact: true })).toContainText(`NODE_TOKEN: ${nodeToken}`);
  await expect(nodeDialog.getByLabel('docker-compose.yml', { exact: true })).toContainText(`HUB_URL: ws://localhost:${WEB_PORT}/link`);
  await nodeDialog.getByRole('button', { name: /close/ }).click();
  await expect(page.getByText(nodeToken)).toHaveCount(0);
  const nodeRow = page.getByRole('row', { name: /e2e-node/ });
  await expect(nodeRow).toContainText('offline');

  // Tokens: create with the node, setup link + QR
  await page.getByRole('button', { name: 'Tokens' }).click();
  await page.getByRole('button', { name: 'Create token' }).click();
  await page.getByLabel(/^Label/).fill('for a friend');
  await page.getByLabel('e2e-node').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  const tokenDialog = page.getByRole('dialog', { name: 'Token created' });
  const playerToken = (await tokenDialog.getByLabel('Player token', { exact: true }).textContent())!;
  expect(playerToken).toMatch(/^dc1_/);
  await expect(tokenDialog.getByLabel('Setup link', { exact: true })).toContainText(`http://localhost:${WEB_PORT}/#setup-token=`);
  await expect(tokenDialog.getByRole('img', { name: /QR code/ })).toBeVisible();
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}portal.png` });
  await tokenDialog.getByRole('button', { name: /close/ }).click();
  await expect(page.getByText(playerToken)).toHaveCount(0);

  // Revoke
  const tokenRow = page.getByRole('row', { name: /for a friend/ });
  await expect(tokenRow).toContainText('active');
  await page.getByRole('button', { name: 'Revoke token for a friend' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke token' }).click();
  await expect(tokenRow).toContainText('revoked');

  // The session cookie survives a reload; the admin (HUB_ADMIN_LICHESS) sees the admin section.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nodes' })).toBeVisible();
  await page.getByRole('button', { name: 'Admin' }).click();
  await expect(page.getByRole('cell', { name: 'e2e-node', exact: false }).or(page.getByRole('rowheader', { name: 'e2e-node' }))).toBeVisible();

  // Logout returns to the login screen.
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('button', { name: 'Log in with lichess' })).toBeVisible();
  expect(cspErrors).toEqual([]);
});
