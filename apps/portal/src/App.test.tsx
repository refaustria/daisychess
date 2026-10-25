import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { PENDING_STORAGE_KEY, PORTAL_CLIENT_ID } from './auth/lichess';
import { ADMIN_ME, ADMIN_NODES, ME, OPERATORS, hubMock, node, token, type Call } from './test/hubMock';

const LICHESS_TOKEN = 'lio_secret_access_token_123';
const unauthorized = { status: 401, json: { error: 'unauthorized', message: 'log in first' } };

function lichessMock(opts: { tokenStatus?: number } = {}) {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), method: init?.method ?? 'GET', auth: headers.get('Authorization') });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (opts.tokenStatus && opts.tokenStatus >= 400) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: opts.tokenStatus });
    return new Response(JSON.stringify({ token_type: 'Bearer', access_token: LICHESS_TOKEN, expires_in: 3600 }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function arriveFromLichess(code = 'CODE', state = 'STATE', pendingState = 'STATE'): void {
  globalThis.sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify({ verifier: 'V'.repeat(50), state: pendingState, redirectUri: 'http://localhost:3000/portal/' }));
  globalThis.history.replaceState(null, '', `/portal/?code=${code}&state=${state}`);
}

function storageDump(): string {
  return JSON.stringify({ ...globalThis.localStorage }) + JSON.stringify({ ...globalThis.sessionStorage });
}

describe('login', () => {
  it('shows the login screen without a session and starts PKCE without scopes', async () => {
    const hub = hubMock({ 'GET /me': unauthorized });
    const navigate = vi.fn();
    render(<App fetchImpl={hub.fetchImpl} lichess={{ navigate }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Log in with lichess' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    const url = new URL(navigate.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe('https://lichess.org/oauth');
    expect(url.searchParams.get('client_id')).toBe(PORTAL_CLIENT_ID);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.has('scope')).toBe(false);
    expect(globalThis.sessionStorage.getItem(PENDING_STORAGE_KEY)).toContain('verifier');
  });

  it('completes the lichess callback: posts the token once with the CSRF header, then revokes it and forgets it', async () => {
    arriveFromLichess();
    const hub = hubMock({ 'POST /login': ME, 'GET /nodes': { nodes: [] } });
    const lichess = lichessMock();
    render(<App fetchImpl={hub.fetchImpl} lichess={{ fetch: lichess.fetchImpl }} />);
    expect(await screen.findByRole('heading', { name: 'Nodes' })).toBeTruthy();
    const login = hub.calls.find((c) => c.path === '/login')!;
    expect(login.method).toBe('POST');
    expect(login.headers['X-Requested-With']).toBe('daisychess-portal');
    expect(login.body).toEqual({ lichessToken: LICHESS_TOKEN });
    // exchanged with the verifier, then revoked with the token
    expect(lichess.calls[0]!.url).toBe('https://lichess.org/api/token');
    await waitFor(() => expect(lichess.calls.some((c) => c.method === 'DELETE' && c.auth === `Bearer ${LICHESS_TOKEN}`)).toBe(true));
    expect(storageDump()).not.toContain(LICHESS_TOKEN);
    expect(globalThis.location.search).toBe('');
    expect(globalThis.sessionStorage.getItem(PENDING_STORAGE_KEY)).toBeNull();
    // never asked /me: the login answer is the session
    expect(hub.calls.some((c) => c.path === '/me')).toBe(false);
  });

  it('rejects a callback whose state does not match', async () => {
    arriveFromLichess('CODE', 'EVIL', 'STATE');
    const hub = hubMock({});
    const lichess = lichessMock();
    render(<App fetchImpl={hub.fetchImpl} lichess={{ fetch: lichess.fetchImpl }} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/did not match/);
    expect(lichess.calls).toHaveLength(0);
    expect(hub.calls).toHaveLength(0);
  });

  it('shows a cancelled login', async () => {
    globalThis.history.replaceState(null, '', '/portal/?error=access_denied&state=X');
    render(<App fetchImpl={hubMock({}).fetchImpl} lichess={{ fetch: lichessMock().fetchImpl }} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/cancelled/);
  });

  it('shows the hub refusal and still revokes the lichess token', async () => {
    arriveFromLichess();
    const hub = hubMock({ 'POST /login': { status: 403, json: { error: 'operator_disabled', message: 'x' } } });
    const lichess = lichessMock();
    render(<App fetchImpl={hub.fetchImpl} lichess={{ fetch: lichess.fetchImpl }} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/disabled/);
    await waitFor(() => expect(lichess.calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('shows lichess errors on the token exchange', async () => {
    arriveFromLichess();
    const lichess = lichessMock({ tokenStatus: 400 });
    render(<App fetchImpl={hubMock({}).fetchImpl} lichess={{ fetch: lichess.fetchImpl }} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/lichess refused the login/);
  });
});

describe('nodes', () => {
  const base = { 'GET /me': ME };

  it('lists nodes with status, version, load and sessions', async () => {
    const hub = hubMock({ ...base, 'GET /nodes': { nodes: [node(), node({ id: 'n2', name: 'old', status: 'offline', live: null, state: 'suspect' })] } });
    render(<App fetchImpl={hub.fetchImpl} />);
    const row = (await screen.findByText('garage')).closest('tr')!;
    expect(within(row).getByText('online')).toBeTruthy();
    expect(within(row).getByText('1.2.3')).toBeTruthy();
    expect(within(row).getByText('0.50')).toBeTruthy();
    expect(within(row).getByText('1 / 4')).toBeTruthy();
    expect(within(screen.getByText('old').closest('tr')!).getByText('suspect')).toBeTruthy();
  });

  it('shows suspect-until and the pool ban, and locks the pool toggle while banned', async () => {
    const until = Date.UTC(2026, 10, 1, 12, 0);
    const hub = hubMock({
      ...base,
      'GET /nodes': { nodes: [node({ state: 'suspect', suspectUntil: until, pool: true, poolShare: 2, poolBanned: true, poolBanReason: 'spot-check failures' })] },
    });
    render(<App fetchImpl={hub.fetchImpl} />);
    const row = (await screen.findByText('garage')).closest('tr')!;
    expect(within(row).getByText(/suspect until 2026-11-01 12:00 UTC/)).toBeTruthy();
    expect(within(row).getByText('banned')).toBeTruthy();
    expect(within(row).getByText('Banned from pool (spot-check failures)')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Edit garage' }));
    const dlg = screen.getByRole('dialog');
    expect((within(dlg).getByLabelText(/shared pool/) as HTMLInputElement).disabled).toBe(true);
    expect((within(dlg).getByLabelText(/Pool share/) as HTMLInputElement).disabled).toBe(true);
    expect(within(dlg).getByRole('note').textContent).toMatch(/banned from the pool/);
  });

  it('shows an error with retry when loading fails', async () => {
    let fail = true;
    const hub = hubMock({ ...base, 'GET /nodes': () => (fail ? { status: 500, json: { error: 'internal', message: 'internal error' } } : { json: { nodes: [] } }) });
    render(<App fetchImpl={hub.fetchImpl} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/internal error/);
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No nodes yet/)).toBeTruthy();
  });

  it('creates a node, shows the token once with the snippets, and drops it on close', async () => {
    const created = node({ id: 'n9', name: 'attic', pool: true, poolShare: 2 });
    let listed = [] as ReturnType<typeof node>[];
    const hub = hubMock({
      ...base,
      'GET /nodes': () => ({ json: { nodes: listed } }),
      'POST /nodes': () => {
        listed = [created];
        return { status: 201, json: { node: created, nodeToken: 'dcn_n9_SECRETSECRET' } };
      },
    });
    render(<App fetchImpl={hub.fetchImpl} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create node' }));
    const form = screen.getByRole('dialog');
    await userEvent.type(within(form).getByLabelText(/Name/), 'attic');
    await userEvent.click(within(form).getByLabelText(/shared pool/));
    await userEvent.clear(within(form).getByLabelText(/Pool share/));
    await userEvent.type(within(form).getByLabelText(/Pool share/), '2');
    await userEvent.click(within(form).getByRole('button', { name: 'Create' }));

    const dlg = await screen.findByRole('dialog', { name: /attic created/ });
    expect(hub.calls.find((c) => c.method === 'POST' && c.path === '/nodes')!.body).toEqual({ name: 'attic', pool: true, poolShare: 2 });
    expect(within(dlg).getByLabelText('Node token').textContent).toBe('dcn_n9_SECRETSECRET');
    const compose = within(dlg).getByLabelText('docker-compose.yml').textContent!;
    expect(compose).toContain('HUB_URL: ws://localhost:3000/link');
    expect(compose).toContain('NODE_TOKEN: dcn_n9_SECRETSECRET');
    expect(within(dlg).getByLabelText('npx command').textContent).toContain('npx -y @daisychess/node');
    expect(storageDump()).not.toContain('SECRETSECRET');

    await userEvent.click(within(dlg).getByRole('button', { name: /close/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(screen.getByText('attic')).toBeTruthy());
    expect(document.body.textContent).not.toContain('SECRETSECRET');
  });

  it('shows creation errors in the dialog', async () => {
    const hub = hubMock({ ...base, 'GET /nodes': { nodes: [] }, 'POST /nodes': { status: 409, json: { error: 'limit_reached', message: 'at most 10 nodes per operator' } } });
    render(<App fetchImpl={hub.fetchImpl} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create node' }));
    await userEvent.type(screen.getByLabelText(/Name/), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/at most 10 nodes/);
  });

  it('rotates a token (shown once), renames, revokes and deletes with confirmation', async () => {
    const n = node();
    const hub = hubMock({
      ...base,
      'GET /nodes': { nodes: [n] },
      'POST /nodes/n1/rotate': { json: { node: n, nodeToken: 'dcn_n1_ROTATEDROTATED' } },
      'PATCH /nodes/n1': { json: { node: { ...n, name: 'cellar' } } },
      'POST /nodes/n1/revoke': { json: { node: { ...n, revokedAt: 5 }, linkClosed: true } },
      'DELETE /nodes/n1': { status: 204 },
    });
    render(<App fetchImpl={hub.fetchImpl} />);
    await screen.findByText('garage');

    await userEvent.click(screen.getByRole('button', { name: 'Rotate token of garage' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rotate token' }));
    const dlg = await screen.findByRole('dialog', { name: /New token/ });
    expect(within(dlg).getByLabelText('Node token').textContent).toBe('dcn_n1_ROTATEDROTATED');
    await userEvent.click(within(dlg).getByRole('button', { name: /close/ }));
    expect(document.body.textContent).not.toContain('ROTATEDROTATED');

    await userEvent.click(screen.getByRole('button', { name: 'Edit garage' }));
    const name = screen.getByLabelText(/Name/);
    await userEvent.clear(name);
    await userEvent.type(name, 'cellar');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(hub.calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ name: 'cellar' });

    await userEvent.click(screen.getByRole('button', { name: 'Revoke garage' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke node' }));
    await waitFor(() => expect(hub.calls.some((c) => c.path === '/nodes/n1/revoke')).toBe(true));

    await userEvent.click(screen.getByRole('button', { name: 'Delete garage' }));
    // Cancel keeps it
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(hub.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Delete garage' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete node' }));
    await waitFor(() => expect(hub.calls.some((c) => c.method === 'DELETE' && c.path === '/nodes/n1')).toBe(true));
  });
});

describe('tokens', () => {
  const base = { 'GET /me': ME, 'GET /nodes': { nodes: [node()] } };

  it('lists tokens and creates one with a setup link and QR code, gone after close', async () => {
    let listed = [token()];
    const created = token({ id: 'ZZZZ2222', label: 'for carol' });
    const hub = hubMock({
      ...base,
      'GET /tokens': () => ({ json: { tokens: listed } }),
      'POST /tokens': () => {
        listed = [...listed, created];
        return { status: 201, json: { token: created, playerToken: 'dc1_ZZZZ2222_PLAYERSECRET', setupLink: 'https://play.daisychess.org/#setup-token=dc1_ZZZZ2222_PLAYERSECRET' } };
      },
    });
    render(<App fetchImpl={hub.fetchImpl} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tokens' }));
    const row = (await screen.findByText('for bob')).closest('tr')!;
    expect(within(row).getByText('garage')).toBeTruthy();
    expect(within(row).getByText('active')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const form = screen.getByRole('dialog');
    await userEvent.type(within(form).getByLabelText(/Label/), 'for carol');
    await userEvent.click(within(form).getByLabelText('garage'));
    await userEvent.selectOptions(within(form).getByLabelText('Expires'), '30');
    await userEvent.click(within(form).getByRole('button', { name: 'Create' }));

    const dlg = await screen.findByRole('dialog', { name: 'Token created' });
    const body = hub.calls.find((c) => c.method === 'POST' && c.path === '/tokens')!.body as Record<string, unknown>;
    expect(body).toEqual({ kind: 'player', label: 'for carol', nodeIds: ['n1'], poolFallback: false, tier: 'standard', expiresInDays: 30 });
    expect(within(dlg).getByLabelText('Player token').textContent).toBe('dc1_ZZZZ2222_PLAYERSECRET');
    expect(within(dlg).getByLabelText('Setup link').textContent).toContain('#setup-token=');
    expect(within(dlg).getByRole('img', { name: /QR code/ }).querySelector('path')?.getAttribute('d')).toMatch(/^M/);
    await userEvent.click(within(dlg).getByRole('button', { name: /close/ }));
    expect(document.body.textContent).not.toContain('PLAYERSECRET');
    expect(await screen.findByText('for carol')).toBeTruthy();
  });

  it('revokes a token after confirmation', async () => {
    let t = token();
    const hub = hubMock({
      ...base,
      'GET /tokens': () => ({ json: { tokens: [t] } }),
      'POST /tokens/ABCD2345/revoke': () => {
        t = token({ status: 'revoked', revokedAt: 9 });
        return { json: { token: t, closedConnections: 0 } };
      },
    });
    render(<App fetchImpl={hub.fetchImpl} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tokens' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke token for bob' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke token' }));
    const row = (await screen.findByText('revoked')).closest('tr')!;
    expect(within(row).queryByRole('button', { name: /Revoke/ })).toBeNull();
    expect(hub.calls.find((c) => c.path.endsWith('/revoke'))!.headers['X-Requested-With']).toBe('daisychess-portal');
  });

  it('creates a pool token without node selection', async () => {
    const hub = hubMock({
      ...base,
      'GET /tokens': { tokens: [] },
      'POST /tokens': { status: 201, json: { token: token({ kind: 'pool', nodeIds: [] }), playerToken: 'dc1_X_Y', setupLink: null } },
    });
    render(<App fetchImpl={hub.fetchImpl} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tokens' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create token' }));
    await userEvent.click(screen.getByLabelText(/Pool token/));
    expect(screen.queryByText('Nodes this token may use')).toBeNull();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create' }));
    const dlg = await screen.findByRole('dialog', { name: 'Token created' });
    expect(within(dlg).queryByLabelText('Setup link')).toBeNull();
    expect((hub.calls.find((c) => c.method === 'POST' && c.path === '/tokens')!.body as { nodeIds?: unknown }).nodeIds).toBeUndefined();
  });
});

describe('usage, admin, account', () => {
  it('shows usage per day as chart and table', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const hub = hubMock({
      'GET /me': ME,
      'GET /nodes': { nodes: [node()] },
      'GET /tokens': { tokens: [] },
      'GET /nodes/n1/usage': { nodeId: 'n1', sinceDay: day, days: [{ day, sessions: 3, searches: 40, engineMs: 90_000 }], total: { sessions: 3, searches: 40, engineMs: 90_000 } },
    });
    render(<App fetchImpl={hub.fetchImpl} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Usage' }));
    expect(await screen.findByText(/Total: 3 sessions, 40 searches/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /Sessions: 3 sessions/ })).toBeTruthy();
    const row = screen.getByRole('rowheader', { name: day }).closest('tr')!;
    expect(within(row).getByText('1 min 30 s')).toBeTruthy();
  });

  it('hides the admin section from operators', async () => {
    const hub = hubMock({ 'GET /me': ME, 'GET /nodes': { nodes: [] } });
    render(<App fetchImpl={hub.fetchImpl} />);
    await screen.findByRole('heading', { name: 'Nodes' });
    expect(screen.queryByRole('button', { name: 'Admin' })).toBeNull();
  });

  it('gives administrators the admin section: disable an operator, set a node state', async () => {
    const hub = hubMock({
      'GET /me': ADMIN_ME,
      'GET /nodes': { nodes: [] },
      'GET /admin/operators': { operators: OPERATORS },
      'GET /admin/nodes': { nodes: ADMIN_NODES },
      'POST /admin/operators/op2/disable': { json: { operator: { id: 'op2' } } },
      'POST /admin/nodes/n1/state': { json: { node: node({ state: 'suspect' }) } },
    });
    render(<App fetchImpl={hub.fetchImpl} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Admin' }));
    expect(await screen.findByText('Bob')).toBeTruthy();
    // no self-disable
    expect(screen.queryByRole('button', { name: 'Disable Alice' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Disable Bob' }));
    await waitFor(() => expect(hub.calls.find((c) => c.path === '/admin/operators/op2/disable')!.body).toEqual({ disabled: true }));
    await userEvent.selectOptions(await screen.findByLabelText('State of garage'), 'suspect');
    await waitFor(() => expect(hub.calls.find((c) => c.path === '/admin/nodes/n1/state')!.body).toEqual({ state: 'suspect' }));
  });

  it('lets administrators ban a node from the pool and lift the ban', async () => {
    let banned = false;
    const hub = hubMock({
      'GET /me': ADMIN_ME,
      'GET /nodes': { nodes: [] },
      'GET /admin/operators': { operators: OPERATORS },
      'GET /admin/nodes': () => ({ json: { nodes: [{ ...ADMIN_NODES[0]!, poolBanned: banned }] } }),
      'POST /admin/nodes/n1/state': (c: Call) => {
        banned = (c.body as { poolBanned: boolean }).poolBanned;
        return { json: { node: node({ poolBanned: banned }) } };
      },
    });
    render(<App fetchImpl={hub.fetchImpl} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Admin' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ban from pool: garage' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Lift pool ban of garage' }));
    await screen.findByRole('button', { name: 'Ban from pool: garage' });
    const posts = hub.calls.filter((c) => c.method === 'POST').map((c) => c.body);
    expect(posts).toEqual([{ poolBanned: true }, { poolBanned: false }]);
  });

  it('shows account facts, the deletion note, and logs out', async () => {
    const hub = hubMock({ 'GET /me': ME, 'GET /nodes': { nodes: [] }, 'POST /logout': { status: 204 } });
    render(<App fetchImpl={hub.fetchImpl} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Account' }));
    expect(screen.getByText(/contact the hub administrator/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('button', { name: 'Log in with lichess' })).toBeTruthy();
  });

  it('returns to the login screen when the session ends', async () => {
    let expired = false;
    const hub = hubMock({ 'GET /me': ME, 'GET /nodes': () => (expired ? unauthorized : { json: { nodes: [] } }), 'GET /tokens': { tokens: [] } });
    render(<App fetchImpl={hub.fetchImpl} />);
    await screen.findByRole('heading', { name: 'Nodes' });
    expired = true;
    await userEvent.click(screen.getByRole('button', { name: 'Nodes' }));
    // re-mount via tab switch: go to Tokens (loads nodes too), which now gets 401
    await userEvent.click(screen.getByRole('button', { name: 'Tokens' }));
    expect(await screen.findByRole('button', { name: 'Log in with lichess' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/session has ended/);
  });
});
