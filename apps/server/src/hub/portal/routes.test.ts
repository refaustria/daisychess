import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { TOKEN_PATTERNS, type Limits } from '@daisychess/engine-core';
import type { PortalSettings } from '../../config.js';
import { loadSqlite } from '../../review/ReviewStore.js';
import { HubNodeLink } from '../HubNodeLink.js';
import { NodeRegistry } from '../NodeRegistry.js';
import { HubStore, utcDay } from '../store/HubStore.js';
import { HubTokenService, LOCAL_NODE_ID, POOL_TOKEN_DEFAULT_TTL_MS } from '../tokens.js';
import { PORTAL_COOKIE, PORTAL_SESSION_TTL_MS, hashSessionId } from './auth.js';
import { LichessError, createLichessFetcher, type LichessAccountFetcher } from './lichess.js';
import { appSetupLink, registerPortalRoutes, type PortalOptions } from './routes.js';

const sqlite = await loadSqlite();
const ORIGIN = 'https://hub.example';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const CSRF = { origin: ORIGIN, 'x-requested-with': 'daisychess-portal' };
const LIMITS: Limits = {
  maxDepth: 20,
  maxMultipv: 3,
  maxThreads: 2,
  maxHash: 64,
  maxMovetimeMs: 60_000,
  maxSessionsPerConnection: 2,
};
const silent = { info() {}, warn() {}, error() {}, debug() {} };

const SETTINGS: PortalSettings = {
  publicOrigin: ORIGIN,
  adminLichessIds: ['bojan'],
  lichessProxy: 'http://127.0.0.1:1/lichess/',
  lichessTimeoutMs: 5_000,
  maxNodes: 3,
  maxTokens: 5,
  poolTokensPerOperator: 2,
};

let dir: string;
let store: HubStore;
let tokens: HubTokenService;
let registry: NodeRegistry;
let app: FastifyInstance;
let clock: number;
let logs: string[];
let links: { closeNode: ReturnType<typeof vi.fn>; evictShared: ReturnType<typeof vi.fn> };
let conns: {
  closeTokenConnections: ReturnType<typeof vi.fn>;
  tokenConnections: ReturnType<typeof vi.fn>;
};
/** lichess tokens the fake lichess accepts → account. */
let accounts: Map<string, { id: string; username: string }>;
let fetchAccount: ReturnType<typeof vi.fn>;
/** Every secret a test saw (lichess tokens, cookies, dc1_/dcn_ tokens): must never be logged. */
let secrets: string[];

async function setup(over: Partial<PortalOptions> = {}): Promise<void> {
  dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-portal-'));
  store = await HubStore.open({ path: path.join(dir, 'hub.sqlite') }, silent);
  tokens = new HubTokenService(store, {
    accessToken: null,
    poolDailyBudgetMin: 30,
    usageRetentionDays: 90,
  });
  registry = new NodeRegistry(silent);
  links = { closeNode: vi.fn(() => true), evictShared: vi.fn(() => 0) };
  conns = { closeTokenConnections: vi.fn(() => 0), tokenConnections: vi.fn(() => 0) };
  accounts = new Map([
    ['lio_anna', { id: 'anna', username: 'Anna' }],
    ['lio_bob', { id: 'bob', username: 'Bob' }],
    ['lio_bojan', { id: 'bojan', username: 'Bojan' }],
  ]);
  secrets = [...accounts.keys()];
  fetchAccount = vi.fn(async (t: string) => {
    const a = accounts.get(t);
    if (!a) throw new LichessError('rejected', 'lichess rejected the token');
    return a;
  });
  clock = T0;
  logs = [];
  app = Fastify({
    logger: { level: 'trace', stream: { write: (line: string) => void logs.push(line) } },
  });
  await registerPortalRoutes(app, {
    store,
    tokens,
    registry,
    links,
    connections: conns,
    settings: SETTINGS,
    allowedOrigins: null,
    trustedProxies: [],
    fetchAccount: fetchAccount as unknown as LichessAccountFetcher,
    logger: app.log,
    now: () => clock,
    apiRateLimit: { max: 10_000, windowMs: 60_000 },
    loginRateLimit: { max: 10_000, windowMs: 60_000 },
    ...over,
  });
  await app.ready();
}

function teardownChecks(): void {
  const all = logs.join('\n');
  for (const s of secrets) expect(all).not.toContain(s);
  expect(all).not.toMatch(/dc1_[a-z2-7]{8}_[a-z2-7]{32}/);
  expect(all).not.toMatch(/dcn_[a-z2-7]{8}_[a-z2-7]{32}/);
  expect(all).not.toContain(PORTAL_COOKIE + '=');
  expect(all).not.toContain('203.0.113.');
}

afterEach(async () => {
  await app?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type Res = Awaited<ReturnType<FastifyInstance['inject']>>;

async function req(
  method: InjectOptions['method'],
  url: string,
  opts: { cookie?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {
    ...(method === 'GET' ? {} : CSRF),
    'x-real-ip': '203.0.113.9',
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...opts.headers,
  };
  return app.inject({
    method,
    url: `/api/portal${url}`,
    headers,
    ...(opts.body === undefined ? {} : { payload: opts.body as object }),
    ...(opts.ip ? { remoteAddress: opts.ip } : {}),
  });
}

/** Logs in; returns the `Cookie` header value. */
async function login(who: 'anna' | 'bob' | 'bojan' = 'anna'): Promise<string> {
  const res = await req('POST', '/login', { body: { lichessToken: `lio_${who}` } });
  expect(res.statusCode).toBe(200);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  secrets.push(cookie.split('=')[1]!);
  return cookie;
}

function remember(token: string): string {
  secrets.push(token);
  return token;
}

const linkFor = (nodeId: string) =>
  new HubNodeLink({ nodeId, send: () => true, logger: silent, onAbuse: () => {} });

function connect(nodeId: string, operatorId: string, pool = true) {
  return registry.register({
    nodeId,
    name: 'old-name',
    operatorId,
    version: '0.3.1',
    platform: 'linux',
    arch: 'arm64',
    engines: [{ id: 'sf', name: 'SF', enabled: true, defaults: { threads: 1, hash: 16 } }],
    limits: LIMITS,
    maxSessions: 4,
    pool,
    nodePool: true,
    poolShare: 1,
    connectedAt: T0,
    link: linkFor(nodeId),
  });
}

describe.skipIf(!sqlite)('portal API: login, session, CSRF (M24-9)', () => {
  beforeEach(() => setup());
  afterEach(() => teardownChecks());

  it('login verifies through lichess, upserts id + username only, sets a __Host- session cookie', async () => {
    const res = await req('POST', '/login', { body: { lichessToken: 'lio_anna' } });
    expect(res.statusCode).toBe(200);
    expect(fetchAccount).toHaveBeenCalledWith('lio_anna');
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(
      /^__Host-dc_portal=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; Secure; HttpOnly; SameSite=Strict$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.operator).toMatchObject({ lichessId: 'anna', username: 'Anna', admin: false });
    expect(body.sessionExpiresAt).toBe(T0 + PORTAL_SESSION_TTL_MS);
    expect(body.limits).toEqual({ maxNodes: 3, maxTokens: 5, poolTokens: 2 });
    // Only the hash of the session id is stored; the lichess token is not stored anywhere.
    const sid = setCookie.split(';')[0]!.split('=')[1]!;
    secrets.push(sid);
    expect(store.getPortalSession(hashSessionId(sid), T0)?.operatorId).toBe(body.operator.id);
    const raw = readFileSync(path.join(dir, 'hub.sqlite')).toString('latin1');
    expect(raw).not.toContain(sid);
    expect(raw).not.toContain('lio_anna');
    expect(store.getOperatorByLichessId('anna')).toMatchObject({ username: 'Anna' });

    const me = await req('GET', '/me', { cookie: setCookie.split(';')[0]! });
    expect(me.statusCode).toBe(200);
    expect(me.json().operator.username).toBe('Anna');
  });

  it('lichess rejecting the token → 401, lichess unavailable → 502, bad bodies → 400; no cookie', async () => {
    const rejected = await req('POST', '/login', { body: { lichessToken: 'lio_wrong' } });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().error).toBe('lichess_rejected');
    expect(rejected.headers['set-cookie']).toBeUndefined();
    secrets.push('lio_wrong');

    fetchAccount.mockRejectedValueOnce(new LichessError('unavailable', 'lichess answered 503'));
    const down = await req('POST', '/login', { body: { lichessToken: 'lio_anna' } });
    expect(down.statusCode).toBe(502);
    expect(down.json().error).toBe('lichess_unavailable');
    expect(down.headers['set-cookie']).toBeUndefined();

    fetchAccount.mockRejectedValueOnce(new Error('boom'));
    expect((await req('POST', '/login', { body: { lichessToken: 'lio_anna' } })).statusCode).toBe(
      502,
    );

    for (const body of [
      {},
      { lichessToken: '' },
      { lichessToken: 'a b' },
      { lichessToken: 'x'.repeat(513) },
      { lichessToken: 'lio_anna', extra: 1 },
    ]) {
      const r = await req('POST', '/login', { body });
      expect(r.statusCode).toBe(400);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    expect((await req('POST', '/login')).statusCode).toBe(400);
    expect(store.listOperators()).toEqual([]);
  });

  it('a lichess timeout (real fetcher, hanging upstream) → 502 within the timeout', async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    await setup({
      fetchAccount: createLichessFetcher({
        baseUrl: SETTINGS.lichessProxy,
        timeoutMs: 50,
        fetch: hanging,
      }),
    });
    const started = Date.now();
    const res = await req('POST', '/login', { body: { lichessToken: 'lio_anna' } });
    expect(res.statusCode).toBe(502);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('CSRF: state-changing requests need X-Requested-With and a same-origin Origin (login included)', async () => {
    const cookie = await login();
    const routes: [InjectOptions['method'], string, unknown][] = [
      ['POST', '/login', { lichessToken: 'lio_anna' }],
      ['POST', '/logout', undefined],
      ['POST', '/nodes', { name: 'x' }],
      ['PATCH', '/nodes/aaaaaaaa', { name: 'x' }],
      ['POST', '/nodes/aaaaaaaa/rotate', undefined],
      ['POST', '/nodes/aaaaaaaa/revoke', undefined],
      ['DELETE', '/nodes/aaaaaaaa', undefined],
      ['POST', '/tokens', { kind: 'pool' }],
      ['PATCH', '/tokens/aaaaaaaa', { label: 'x' }],
      ['POST', '/tokens/aaaaaaaa/revoke', undefined],
      ['POST', '/admin/operators/aaaaaaaa/disable', { disabled: true }],
      ['POST', '/admin/nodes/aaaaaaaa/state', { state: 'normal' }],
    ];
    const variants: Record<string, string>[] = [
      { origin: ORIGIN },
      { origin: ORIGIN, 'x-requested-with': 'XMLHttpRequest' },
      { 'x-requested-with': 'daisychess-portal' },
      { origin: 'https://evil.example', 'x-requested-with': 'daisychess-portal' },
      { origin: 'null', 'x-requested-with': 'daisychess-portal' },
    ];
    for (const [method, url, body] of routes) {
      for (const headers of variants) {
        const res = await app.inject({
          method,
          url: `/api/portal${url}`,
          headers: { cookie, ...headers },
          ...(body === undefined ? {} : { payload: body as object }),
        });
        expect(res.statusCode, `${method} ${url} ${JSON.stringify(headers)}`).toBe(403);
        expect(res.json().error).toBe('csrf');
      }
    }
    expect(fetchAccount).toHaveBeenCalledTimes(1);
    // Safe methods need no CSRF header.
    expect((await req('GET', '/me', { cookie })).statusCode).toBe(200);
  });

  it('every authenticated route answers 401 without a valid session', async () => {
    const routes: [InjectOptions['method'], string, unknown][] = [
      ['POST', '/logout', undefined],
      ['GET', '/me', undefined],
      ['GET', '/nodes', undefined],
      ['POST', '/nodes', { name: 'x' }],
      ['GET', '/nodes/aaaaaaaa', undefined],
      ['PATCH', '/nodes/aaaaaaaa', { name: 'x' }],
      ['POST', '/nodes/aaaaaaaa/rotate', undefined],
      ['POST', '/nodes/aaaaaaaa/revoke', undefined],
      ['DELETE', '/nodes/aaaaaaaa', undefined],
      ['GET', '/nodes/aaaaaaaa/usage', undefined],
      ['GET', '/tokens', undefined],
      ['POST', '/tokens', { kind: 'pool' }],
      ['GET', '/tokens/aaaaaaaa', undefined],
      ['PATCH', '/tokens/aaaaaaaa', { label: 'x' }],
      ['POST', '/tokens/aaaaaaaa/revoke', undefined],
      ['GET', '/tokens/aaaaaaaa/usage', undefined],
      ['GET', '/admin/operators', undefined],
      ['GET', '/admin/nodes', undefined],
      ['POST', '/admin/operators/aaaaaaaa/disable', { disabled: true }],
      ['POST', '/admin/nodes/aaaaaaaa/state', { state: 'normal' }],
    ];
    const bogus = `${PORTAL_COOKIE}=${'A'.repeat(43)}`;
    for (const [method, url, body] of routes) {
      for (const cookie of [undefined, bogus, `${PORTAL_COOKIE}=short`]) {
        const res = await req(method, url, { ...(cookie ? { cookie } : {}), body });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
        expect(res.json().error).toBe('unauthorized');
      }
    }
  });

  it('sessions expire after 30 days; logout ends the session and clears the cookie; re-login drops the old one', async () => {
    const cookie = await login();
    clock = T0 + PORTAL_SESSION_TTL_MS - 1;
    expect((await req('GET', '/me', { cookie })).statusCode).toBe(200);
    clock = T0 + PORTAL_SESSION_TTL_MS;
    expect((await req('GET', '/me', { cookie })).statusCode).toBe(401);

    clock = T0;
    const second = await login();
    const out = await req('POST', '/logout', { cookie: second });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toBe(
      '__Host-dc_portal=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict',
    );
    expect((await req('GET', '/me', { cookie: second })).statusCode).toBe(401);

    const third = await login();
    const relog = await req('POST', '/login', {
      cookie: third,
      body: { lichessToken: 'lio_anna' },
    });
    secrets.push(String(relog.headers['set-cookie']).split(';')[0]!.split('=')[1]!);
    expect((await req('GET', '/me', { cookie: third })).statusCode).toBe(401);
  });

  it('a disabled operator cannot log in; an existing session stops working', async () => {
    const cookie = await login('bob');
    const bob = store.getOperatorByLichessId('bob')!;
    store.setOperatorDisabled(bob.id, true, T0);
    expect((await req('GET', '/me', { cookie })).statusCode).toBe(401);
    const res = await req('POST', '/login', { body: { lichessToken: 'lio_bob' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('operator_disabled');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rate limits: logins per IP, API calls per IP and per session (429 + Retry-After)', async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    await setup({
      loginRateLimit: { max: 2, windowMs: 60_000 },
      apiRateLimit: { max: 3, windowMs: 60_000 },
    });
    const cookie = await login();
    await login();
    const limited = await req('POST', '/login', { body: { lichessToken: 'lio_anna' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.json().error).toBe('rate_limited');
    // Another address may still log in.
    const bobLogin = await req('POST', '/login', {
      body: { lichessToken: 'lio_bob' },
      ip: '192.0.2.1',
    });
    expect(bobLogin.statusCode).toBe(200);
    const bob = String(bobLogin.headers['set-cookie']).split(';')[0]!;
    secrets.push(bob.split('=')[1]!);

    for (let i = 0; i < 3; i++) expect((await req('GET', '/me', { cookie })).statusCode).toBe(200);
    // Per IP: the 4th call from this address is refused (any session).
    expect((await req('GET', '/me', { cookie })).statusCode).toBe(429);
    expect((await req('GET', '/me', { cookie: bob })).statusCode).toBe(429);
    // Per session: the same session from a fresh address is refused too.
    expect((await req('GET', '/me', { cookie, ip: '192.0.2.2' })).statusCode).toBe(429);
    // A fresh address with a fresh session is fine.
    expect((await req('GET', '/me', { cookie: bob, ip: '192.0.2.3' })).statusCode).toBe(200);
    // The window resets.
    clock += 60_000;
    expect((await req('GET', '/me', { cookie })).statusCode).toBe(200);
  });

  it('unknown portal paths 404; big bodies 413; malformed JSON 400', async () => {
    const cookie = await login();
    expect((await req('GET', '/nope', { cookie })).statusCode).toBe(404);
    const big = await req('POST', '/nodes', { cookie, body: { name: 'x'.repeat(10_000) } });
    expect(big.statusCode).toBe(413);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/portal/nodes',
      headers: { ...CSRF, cookie, 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid');
  });
});

describe.skipIf(!sqlite)('portal API: nodes (M24-9)', () => {
  beforeEach(() => setup());
  afterEach(() => teardownChecks());

  it('create shows the dcn_ token once; list/get never show it; live status from the registry', async () => {
    const cookie = await login();
    const created = await req('POST', '/nodes', {
      cookie,
      body: { name: 'fast-box', pool: true, poolShare: 2 },
    });
    expect(created.statusCode).toBe(201);
    const { node, nodeToken } = created.json();
    remember(nodeToken);
    expect(nodeToken).toMatch(TOKEN_PATTERNS.node);
    expect(nodeToken).toContain(node.id);
    expect(tokens.verifyNodeToken(nodeToken, T0)).toMatchObject({ kind: 'node' });
    expect(node).toMatchObject({
      name: 'fast-box',
      pool: true,
      poolShare: 2,
      state: 'normal',
      status: 'offline',
      live: null,
    });

    const list = await req('GET', '/nodes', { cookie });
    const text = list.body;
    expect(text).not.toContain(nodeToken);
    expect(text).not.toContain(nodeToken.split('_')[2]);
    expect(text).not.toMatch(/hash|secret/i);
    expect(list.json().nodes).toHaveLength(1);

    connect(node.id, store.getOperatorByLichessId('anna')!.id);
    const one = await req('GET', `/nodes/${node.id}`, { cookie });
    expect(one.json().node).toMatchObject({
      status: 'online',
      lastVersion: '0.3.1',
      live: {
        version: '0.3.1',
        arch: 'arm64',
        engines: ['sf'],
        maxSessions: 4,
        clients: 0,
        inPool: true,
      },
    });
    expect(one.body).not.toContain(nodeToken);
  });

  it('rename / pool / poolShare apply to the store and the connected node at once', async () => {
    const cookie = await login();
    const { node } = (
      await req('POST', '/nodes', { cookie, body: { name: 'a', pool: true, poolShare: 1 } })
    ).json();
    connect(node.id, store.getOperatorByLichessId('anna')!.id);
    const patched = await req('PATCH', `/nodes/${node.id}`, {
      cookie,
      body: { name: 'renamed', poolShare: 3 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().node).toMatchObject({ name: 'renamed', poolShare: 3, pool: true });
    expect(registry.get(node.id)).toMatchObject({ name: 'renamed', poolShare: 3, pool: true });
    await req('PATCH', `/nodes/${node.id}`, { cookie, body: { pool: false } });
    expect(registry.get(node.id)?.pool).toBe(false);
    expect(registry.poolCandidates()).toEqual([]);

    for (const body of [
      {},
      { name: '' },
      { poolShare: -1 },
      { poolShare: 1.5 },
      { name: 'x'.repeat(40) },
      { bogus: 1 },
    ]) {
      expect((await req('PATCH', `/nodes/${node.id}`, { cookie, body })).statusCode).toBe(400);
    }
  });

  it('rotate returns a new token once and keeps the old one for 24 h; revoke closes the link; delete removes it', async () => {
    const cookie = await login();
    const created = (await req('POST', '/nodes', { cookie, body: { name: 'a' } })).json();
    remember(created.nodeToken);
    const rotated = await req('POST', `/nodes/${created.node.id}/rotate`, { cookie });
    expect(rotated.statusCode).toBe(200);
    const fresh = remember(rotated.json().nodeToken);
    expect(fresh).not.toBe(created.nodeToken);
    expect(rotated.json().node.rotationOverlapUntil).toBe(T0 + DAY);
    expect(tokens.verifyNodeToken(fresh, T0)).toMatchObject({ kind: 'node' });
    expect(tokens.verifyNodeToken(created.nodeToken, T0)).toMatchObject({ kind: 'node' });
    expect((await req('GET', '/nodes', { cookie })).body).not.toContain(fresh);

    const revoked = await req('POST', `/nodes/${created.node.id}/revoke`, { cookie });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      node: { revokedAt: T0, rotationOverlapUntil: null },
      linkClosed: true,
    });
    expect(links.closeNode).toHaveBeenCalledWith(created.node.id, 'revoked', expect.any(String));
    expect(tokens.verifyNodeToken(fresh, T0)).toEqual({ error: 'revoked' });
    expect((await req('POST', `/nodes/${created.node.id}/rotate`, { cookie })).statusCode).toBe(
      400,
    );
    expect(
      (await req('PATCH', `/nodes/${created.node.id}`, { cookie, body: { name: 'b' } })).statusCode,
    ).toBe(400);

    links.closeNode.mockClear();
    const del = await req('DELETE', `/nodes/${created.node.id}`, { cookie });
    expect(del.statusCode).toBe(204);
    expect(links.closeNode).toHaveBeenCalledWith(created.node.id, 'revoked', expect.any(String));
    expect(store.getNode(created.node.id)).toBeUndefined();
    expect((await req('GET', `/nodes/${created.node.id}`, { cookie })).statusCode).toBe(404);
  });

  it('per-node usage: last 30 days, summed over tokens (no token ids)', async () => {
    const cookie = await login();
    const { node } = (await req('POST', '/nodes', { cookie, body: { name: 'a' } })).json();
    tokens.addEngineTime('tok1tok1', 5_000, { nodeId: node.id, now: T0 });
    tokens.addEngineTime('tok2tok2', 7_000, { nodeId: node.id, now: T0 });
    tokens.addEngineTime('tok1tok1', 9_000, { nodeId: node.id, now: T0 - 40 * DAY });
    const res = await req('GET', `/nodes/${node.id}/usage`, { cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      nodeId: node.id,
      sinceDay: utcDay(T0 - 29 * DAY),
      days: [{ day: utcDay(T0), sessions: 0, searches: 2, engineMs: 12_000 }],
      total: { sessions: 0, searches: 2, engineMs: 12_000 },
    });
    expect(res.body).not.toContain('tok1tok1');
  });

  it('PORTAL_MAX_NODES: the next create is 409; a revoked node frees its slot', async () => {
    const cookie = await login();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await req('POST', '/nodes', { cookie, body: { name: `n${i}` } });
      expect(r.statusCode).toBe(201);
      remember(r.json().nodeToken);
      ids.push(r.json().node.id);
    }
    const over = await req('POST', '/nodes', { cookie, body: { name: 'n3' } });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe('limit_reached');
    await req('POST', `/nodes/${ids[0]}/revoke`, { cookie });
    const again = await req('POST', '/nodes', { cookie, body: { name: 'n3' } });
    expect(again.statusCode).toBe(201);
    remember(again.json().nodeToken);
  });
});

describe.skipIf(!sqlite)('portal API: tokens (M24-9)', () => {
  beforeEach(() => setup());
  afterEach(() => teardownChecks());

  async function nodeOf(cookie: string, name = 'box'): Promise<string> {
    const r = (await req('POST', '/nodes', { cookie, body: { name } })).json();
    remember(r.nodeToken);
    return r.node.id;
  }

  it('create shows the dc1_ token once with a setup link; list/get never show it', async () => {
    const cookie = await login();
    const nodeId = await nodeOf(cookie);
    const created = await req('POST', '/tokens', {
      cookie,
      body: {
        kind: 'player',
        label: "Anna's iPad",
        nodeIds: [nodeId],
        poolFallback: true,
        tier: 'standard',
        expiresInDays: 7,
      },
    });
    expect(created.statusCode).toBe(201);
    const { token, playerToken, setupLink, appLink } = created.json();
    remember(playerToken);
    expect(playerToken).toMatch(TOKEN_PATTERNS.player);
    expect(setupLink).toBe(`${ORIGIN}/#setup-token=${encodeURIComponent(playerToken)}`);
    expect(appLink).toBe(
      `daisychess://setup?token=${encodeURIComponent(playerToken)}&hub=${encodeURIComponent('wss://hub.example/ws')}`,
    );
    expect(token).toMatchObject({
      kind: 'player',
      label: "Anna's iPad",
      nodeIds: [nodeId],
      poolFallback: true,
      tier: 'standard',
      expiresAt: T0 + 7 * DAY,
      status: 'active',
      connections: 0,
    });
    expect(tokens.verifyPlayerToken(playerToken, T0)).toMatchObject({ kind: 'token' });

    for (const url of ['/tokens', `/tokens/${token.id}`]) {
      const r = await req('GET', url, { cookie });
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain(playerToken);
      expect(r.body).not.toContain(playerToken.split('_')[2]);
      expect(r.body).not.toMatch(/hash|secret|setup-token/i);
    }

    const pool = await req('POST', '/tokens', { cookie, body: { kind: 'pool', label: 'friends' } });
    expect(pool.statusCode).toBe(201);
    remember(pool.json().playerToken);
    expect(pool.json().token).toMatchObject({
      kind: 'pool',
      nodeIds: [],
      tier: 'standard',
      expiresAt: T0 + POOL_TOKEN_DEFAULT_TTL_MS,
    });

    conns.tokenConnections.mockImplementation((id: string) => (id === token.id ? 2 : 0));
    expect((await req('GET', `/tokens/${token.id}`, { cookie })).json().token.connections).toBe(2);
  });

  it('create validation: kinds, node rules, expiry, tier, unknown fields', async () => {
    const cookie = await login();
    const nodeId = await nodeOf(cookie);
    const bad: unknown[] = [
      { kind: 'anonymous' },
      { kind: 'player' },
      { kind: 'player', nodeIds: [] },
      { kind: 'pool', nodeIds: [nodeId] },
      { kind: 'player', nodeIds: [nodeId], tier: 'huge' },
      { kind: 'player', nodeIds: [nodeId], expiresAt: T0 - 1 },
      { kind: 'player', nodeIds: [nodeId], expiresAt: T0 + DAY, expiresInDays: 1 },
      { kind: 'player', nodeIds: [nodeId], label: 'x'.repeat(65) },
      { kind: 'player', nodeIds: [nodeId, nodeId] },
      { kind: 'player', nodeIds: ['NOT-AN-ID'] },
      { kind: 'player', nodeIds: [nodeId], secret: 'x' },
    ];
    for (const body of bad) {
      const r = await req('POST', '/tokens', { cookie, body });
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    // Unknown (well-formed) node and the hub's own node for a non-admin: 404.
    expect(
      (await req('POST', '/tokens', { cookie, body: { nodeIds: ['zzzzzzzz'] } })).statusCode,
    ).toBe(404);
    expect(
      (await req('POST', '/tokens', { cookie, body: { nodeIds: [LOCAL_NODE_ID] } })).statusCode,
    ).toBe(404);
    expect(store.listTokens()).toEqual([]);
  });

  it('patch changes label, nodes, fallback, tier and expiry without re-issuing', async () => {
    const cookie = await login();
    const a = await nodeOf(cookie, 'a');
    const b = await nodeOf(cookie, 'b');
    const created = (await req('POST', '/tokens', { cookie, body: { nodeIds: [a] } })).json();
    const secretBefore = remember(created.playerToken);
    const r = await req('PATCH', `/tokens/${created.token.id}`, {
      cookie,
      body: {
        label: 'moved',
        nodeIds: [b, a],
        poolFallback: true,
        tier: 'small',
        expiresInDays: 1,
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().token).toMatchObject({
      label: 'moved',
      nodeIds: [b, a],
      poolFallback: true,
      tier: 'small',
      expiresAt: T0 + DAY,
    });
    expect(r.body).not.toContain(secretBefore);
    expect(tokens.verifyPlayerToken(secretBefore, T0)).toMatchObject({ kind: 'token' });
    expect(
      (
        await req('PATCH', `/tokens/${created.token.id}`, { cookie, body: { expiresAt: null } })
      ).json().token.expiresAt,
    ).toBeNull();
    expect(
      (await req('PATCH', `/tokens/${created.token.id}`, { cookie, body: {} })).statusCode,
    ).toBe(400);
    expect(
      (await req('PATCH', `/tokens/${created.token.id}`, { cookie, body: { nodeIds: [] } }))
        .statusCode,
    ).toBe(400);
  });

  it('revoke closes the open connections of the token and reports how many', async () => {
    const cookie = await login();
    const nodeId = await nodeOf(cookie);
    const created = (await req('POST', '/tokens', { cookie, body: { nodeIds: [nodeId] } })).json();
    remember(created.playerToken);
    conns.closeTokenConnections.mockReturnValueOnce(2);
    const r = await req('POST', `/tokens/${created.token.id}/revoke`, { cookie });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      token: { status: 'revoked', revokedAt: T0, connections: 0 },
      closedConnections: 2,
    });
    expect(conns.closeTokenConnections).toHaveBeenCalledWith(created.token.id);
    expect(tokens.verifyPlayerToken(created.playerToken, T0)).toEqual({ error: 'revoked' });
    expect(
      (await req('PATCH', `/tokens/${created.token.id}`, { cookie, body: { label: 'x' } }))
        .statusCode,
    ).toBe(400);
    // Idempotent.
    expect(
      (await req('POST', `/tokens/${created.token.id}/revoke`, { cookie })).json().token.revokedAt,
    ).toBe(T0);
  });

  it('per-token usage: last 30 days, by day and by node; other operators\' pool nodes summed as "pool"', async () => {
    const cookie = await login();
    const own = await nodeOf(cookie);
    const created = (
      await req('POST', '/tokens', { cookie, body: { nodeIds: [own], poolFallback: true } })
    ).json();
    remember(created.playerToken);
    const id = created.token.id;
    tokens.recordSession(id, own, T0);
    tokens.addEngineTime(id, 4_000, { nodeId: own, now: T0 });
    tokens.addEngineTime(id, 6_000, { nodeId: 'bobsnode', now: T0 - DAY });
    tokens.addEngineTime(id, 1_000, { nodeId: 'othernod', now: T0 - DAY });
    tokens.addEngineTime(id, 9_999, { nodeId: own, now: T0 - 30 * DAY });
    const r = await req('GET', `/tokens/${id}/usage`, { cookie });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.days).toEqual([
      { day: utcDay(T0 - DAY), sessions: 0, searches: 2, engineMs: 7_000 },
      { day: utcDay(T0), sessions: 1, searches: 1, engineMs: 4_000 },
    ]);
    expect(body.byNode).toEqual(
      expect.arrayContaining([
        { nodeId: own, sessions: 1, searches: 1, engineMs: 4_000 },
        { nodeId: 'pool', sessions: 0, searches: 2, engineMs: 7_000 },
      ]),
    );
    expect(body.byNode).toHaveLength(2);
    expect(body.total).toEqual({ sessions: 1, searches: 3, engineMs: 11_000 });
    expect(r.body).not.toContain('bobsnode');
  });

  it('PORTAL_MAX_TOKENS and POOL_TOKENS_PER_OPERATOR: 409; revoked and expired tokens do not count', async () => {
    const cookie = await login();
    const nodeId = await nodeOf(cookie);
    const p1 = (await req('POST', '/tokens', { cookie, body: { kind: 'pool' } })).json();
    remember(p1.playerToken);
    remember((await req('POST', '/tokens', { cookie, body: { kind: 'pool' } })).json().playerToken);
    const overPool = await req('POST', '/tokens', { cookie, body: { kind: 'pool' } });
    expect(overPool.statusCode).toBe(409);
    expect(overPool.json().message).toMatch(/pool/);
    // Player tokens still fit (2 + 3 = 5 = PORTAL_MAX_TOKENS).
    for (let i = 0; i < 3; i++) {
      const r = await req('POST', '/tokens', {
        cookie,
        body: { nodeIds: [nodeId], expiresInDays: 1 },
      });
      expect(r.statusCode).toBe(201);
      remember(r.json().playerToken);
    }
    expect((await req('POST', '/tokens', { cookie, body: { nodeIds: [nodeId] } })).statusCode).toBe(
      409,
    );
    await req('POST', `/tokens/${p1.token.id}/revoke`, { cookie });
    const fits = await req('POST', '/tokens', { cookie, body: { kind: 'pool' } });
    expect(fits.statusCode).toBe(201);
    remember(fits.json().playerToken);
    // Expired tokens free their slots.
    clock = T0 + 2 * DAY;
    const later = await req('POST', '/tokens', { cookie, body: { nodeIds: [nodeId] } });
    expect(later.statusCode).toBe(201);
    remember(later.json().playerToken);
    expect(
      (await req('GET', '/tokens', { cookie }))
        .json()
        .tokens.filter((t: { status: string }) => t.status === 'expired'),
    ).toHaveLength(3);
  });
});

describe.skipIf(!sqlite)('portal API: operator scoping (M24-9)', () => {
  beforeEach(() => setup());
  afterEach(() => teardownChecks());

  it("another operator's node and token ids behave exactly like missing ones (404)", async () => {
    const anna = await login('anna');
    const bob = await login('bob');
    const node = (await req('POST', '/nodes', { cookie: anna, body: { name: 'annas' } })).json();
    remember(node.nodeToken);
    const token = (
      await req('POST', '/tokens', { cookie: anna, body: { nodeIds: [node.node.id] } })
    ).json();
    remember(token.playerToken);
    const n = node.node.id;
    const t = token.token.id;
    const routes: [InjectOptions['method'], string, unknown][] = [
      ['GET', `/nodes/${n}`, undefined],
      ['PATCH', `/nodes/${n}`, { name: 'mine' }],
      ['POST', `/nodes/${n}/rotate`, undefined],
      ['POST', `/nodes/${n}/revoke`, undefined],
      ['DELETE', `/nodes/${n}`, undefined],
      ['GET', `/nodes/${n}/usage`, undefined],
      ['GET', `/tokens/${t}`, undefined],
      ['PATCH', `/tokens/${t}`, { label: 'mine' }],
      ['POST', `/tokens/${t}/revoke`, undefined],
      ['GET', `/tokens/${t}/usage`, undefined],
    ];
    for (const [method, url, body] of routes) {
      const theirs = await req(method, url, { cookie: bob, body });
      const missing = await req(method, url.replace(n, 'zzzzzzzz').replace(t, 'zzzzzzzz'), {
        cookie: bob,
        body,
      });
      const malformed = await req(method, url.replace(n, 'BAD').replace(t, 'BAD'), {
        cookie: bob,
        body,
      });
      expect(theirs.statusCode, `${method} ${url}`).toBe(404);
      expect(theirs.body).toBe(missing.body);
      expect(malformed.statusCode).toBe(404);
    }
    // Bob cannot route a token to Anna's node.
    expect((await req('POST', '/tokens', { cookie: bob, body: { nodeIds: [n] } })).statusCode).toBe(
      404,
    );
    // Lists are per operator.
    expect((await req('GET', '/nodes', { cookie: bob })).json().nodes).toEqual([]);
    expect((await req('GET', '/tokens', { cookie: bob })).json().tokens).toEqual([]);
    // Nothing of Anna's changed.
    expect(store.getNode(n)).toMatchObject({ name: 'annas', revokedAt: null });
    expect(store.getToken(t)).toMatchObject({ label: '', revokedAt: null });
    expect(links.closeNode).not.toHaveBeenCalled();
    expect(conns.closeTokenConnections).not.toHaveBeenCalled();
  });
});

describe.skipIf(!sqlite)('portal API: administrator (M24-9)', () => {
  beforeEach(() => setup());
  afterEach(() => teardownChecks());

  it('admin routes are 403 for operators; HUB_ADMIN_LICHESS gets admin and may use node local', async () => {
    const anna = await login('anna');
    for (const [method, url, body] of [
      ['GET', '/admin/operators', undefined],
      ['GET', '/admin/nodes', undefined],
      ['POST', '/admin/operators/aaaaaaaa/disable', { disabled: true }],
      ['POST', '/admin/nodes/aaaaaaaa/state', { state: 'suspect' }],
    ] as [InjectOptions['method'], string, unknown][]) {
      const r = await req(method, url, { cookie: anna, body });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('forbidden');
    }
    const admin = await login('bojan');
    const me = (await req('GET', '/me', { cookie: admin })).json();
    expect(me.operator.admin).toBe(true);
    expect(store.getOperatorByLichessId('bojan')?.admin).toBe(true);
    const local = await req('POST', '/tokens', {
      cookie: admin,
      body: { nodeIds: [LOCAL_NODE_ID], label: 'phone' },
    });
    expect(local.statusCode).toBe(201);
    remember(local.json().playerToken);
  });

  it('lists every operator and node with owner names, never secrets', async () => {
    const anna = await login('anna');
    const admin = await login('bojan');
    const created = (await req('POST', '/nodes', { cookie: anna, body: { name: 'annas' } })).json();
    remember(created.nodeToken);
    const ops = await req('GET', '/admin/operators', { cookie: admin });
    expect(ops.statusCode).toBe(200);
    const sorted = [...ops.json().operators].sort((a, b) => (a.username < b.username ? -1 : 1));
    expect(sorted).toEqual([
      expect.objectContaining({
        username: 'Anna',
        admin: false,
        nodes: 1,
        liveTokens: 0,
        disabledAt: null,
      }),
      expect.objectContaining({ username: 'Bojan', admin: true, nodes: 0 }),
    ]);
    const nodes = await req('GET', '/admin/nodes', { cookie: admin });
    expect(nodes.json().nodes).toEqual([
      expect.objectContaining({ id: created.node.id, name: 'annas', operatorUsername: 'Anna' }),
    ]);
    expect(nodes.body).not.toContain(created.nodeToken.split('_')[2]);
    expect(nodes.body).not.toMatch(/hash|secret/i);
  });

  it('disabling an operator ends their sessions, closes their links and player connections', async () => {
    const bob = await login('bob');
    const admin = await login('bojan');
    const node = (await req('POST', '/nodes', { cookie: bob, body: { name: 'bobs' } })).json();
    remember(node.nodeToken);
    const token = (
      await req('POST', '/tokens', { cookie: bob, body: { nodeIds: [node.node.id] } })
    ).json();
    remember(token.playerToken);
    const bobId = store.getOperatorByLichessId('bob')!.id;
    conns.closeTokenConnections.mockReturnValue(1);

    const r = await req('POST', `/admin/operators/${bobId}/disable`, {
      cookie: admin,
      body: { disabled: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      operator: { id: bobId, disabledAt: T0 },
      closedLinks: 1,
      closedConnections: 1,
    });
    expect(links.closeNode).toHaveBeenCalledWith(node.node.id, 'revoked', expect.any(String));
    expect(conns.closeTokenConnections).toHaveBeenCalledWith(token.token.id);
    expect((await req('GET', '/me', { cookie: bob })).statusCode).toBe(401);
    expect((await req('POST', '/login', { body: { lichessToken: 'lio_bob' } })).statusCode).toBe(
      403,
    );
    expect(tokens.verifyPlayerToken(token.playerToken, T0)).toEqual({ error: 'revoked' });
    expect(tokens.verifyNodeToken(node.nodeToken, T0)).toEqual({ error: 'revoked' });

    // Lifting the ban.
    const lift = await req('POST', `/admin/operators/${bobId}/disable`, {
      cookie: admin,
      body: { disabled: false },
    });
    expect(lift.json().operator.disabledAt).toBeNull();
    expect(tokens.verifyPlayerToken(token.playerToken, T0)).toMatchObject({ kind: 'token' });
    await login('bob');

    const self = store.getOperatorByLichessId('bojan')!.id;
    expect(
      (
        await req('POST', `/admin/operators/${self}/disable`, {
          cookie: admin,
          body: { disabled: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await req('POST', '/admin/operators/zzzzzzzz/disable', {
          cookie: admin,
          body: { disabled: true },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await req('POST', `/admin/operators/${bobId}/disable`, { cookie: admin, body: {} }))
        .statusCode,
    ).toBe(400);
  });

  it('node state: suspect leaves the pool at once, disabled closes the link and stops verifying, normal restores', async () => {
    const anna = await login('anna');
    const admin = await login('bojan');
    const created = (
      await req('POST', '/nodes', { cookie: anna, body: { name: 'a', pool: true, poolShare: 2 } })
    ).json();
    remember(created.nodeToken);
    const id = created.node.id;
    connect(id, store.getOperatorByLichessId('anna')!.id);
    expect(registry.poolCandidates().map((n) => n.nodeId)).toEqual([id]);

    const suspect = await req('POST', `/admin/nodes/${id}/state`, {
      cookie: admin,
      body: { state: 'suspect' },
    });
    expect(suspect.statusCode).toBe(200);
    expect(suspect.json()).toMatchObject({
      node: { state: 'suspect', live: { inPool: false } },
      linkClosed: false,
    });
    expect(registry.poolCandidates()).toEqual([]);
    // The operator sees the flag.
    expect((await req('GET', `/nodes/${id}`, { cookie: anna })).json().node.state).toBe('suspect');

    const normal = await req('POST', `/admin/nodes/${id}/state`, {
      cookie: admin,
      body: { state: 'normal' },
    });
    expect(normal.json().node.live.inPool).toBe(true);

    const disabled = await req('POST', `/admin/nodes/${id}/state`, {
      cookie: admin,
      body: { state: 'disabled' },
    });
    expect(disabled.json()).toMatchObject({ node: { state: 'disabled' }, linkClosed: true });
    expect(links.closeNode).toHaveBeenCalledWith(id, 'revoked', expect.any(String));
    expect(tokens.verifyNodeToken(created.nodeToken, T0)).toEqual({ error: 'revoked' });

    expect(
      (
        await req('POST', '/admin/nodes/zzzzzzzz/state', {
          cookie: admin,
          body: { state: 'normal' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await req('POST', `/admin/nodes/${id}/state`, { cookie: admin, body: { state: 'bogus' } }))
        .statusCode,
    ).toBe(400);
  });

  it('pool ban (M24-12): shown to the operator, not overridable by them, lifted by the admin only', async () => {
    const anna = await login('anna');
    const admin = await login('bojan');
    const created = (
      await req('POST', '/nodes', { cookie: anna, body: { name: 'a', pool: true, poolShare: 2 } })
    ).json();
    remember(created.nodeToken);
    const id = created.node.id;
    connect(id, store.getOperatorByLichessId('anna')!.id);
    expect(created.node).toMatchObject({ poolBanned: false, poolBanReason: null });

    // The automatic ban after spot-check failures (Reputation) is a store change.
    store.setNodeReputation(id, { state: 'normal', suspectCount: 3, suspectUntil: T0 });
    store.setPoolBan(id, { at: T0, reason: 'spot-check failures' });
    registry.applySettings(id, store.getNode(id)!);
    const seen = (await req('GET', `/nodes/${id}`, { cookie: anna })).json().node;
    expect(seen).toMatchObject({
      state: 'normal',
      suspectCount: 3,
      poolBanned: true,
      poolBanReason: 'spot-check failures',
      live: { inPool: false },
    });
    // The operator's pool switch cannot lift it.
    const patched = await req('PATCH', `/nodes/${id}`, { cookie: anna, body: { pool: true } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().node).toMatchObject({
      pool: true,
      poolBanned: true,
      live: { inPool: false },
    });
    expect(registry.poolCandidates()).toEqual([]);
    // Nor can the operator use the admin route.
    expect(
      (await req('POST', `/admin/nodes/${id}/state`, { cookie: anna, body: { poolBanned: false } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await req('POST', `/admin/nodes/${id}/state`, { cookie: admin, body: {} })).statusCode,
    ).toBe(400);

    const lifted = await req('POST', `/admin/nodes/${id}/state`, {
      cookie: admin,
      body: { poolBanned: false },
    });
    expect(lifted.json()).toMatchObject({
      node: { poolBanned: false, poolBanReason: null, suspectCount: 0, live: { inPool: true } },
      linkClosed: false,
    });
    expect(registry.poolCandidates().map((n) => n.nodeId)).toEqual([id]);
    expect(links.evictShared).not.toHaveBeenCalled();

    // An administrator's ban evicts the node's pool players; the link stays.
    const banned = await req('POST', `/admin/nodes/${id}/state`, {
      cookie: admin,
      body: { poolBanned: true },
    });
    expect(banned.json()).toMatchObject({
      node: { poolBanned: true, poolBanReason: 'hub administrator', state: 'normal' },
      linkClosed: false,
    });
    expect(links.evictShared).toHaveBeenCalledWith(id, expect.any(String));
    expect(links.closeNode).not.toHaveBeenCalled();
    expect(tokens.verifyNodeToken(created.nodeToken, T0)).toMatchObject({ kind: 'node' });
  });
});

describe('appSetupLink', () => {
  it('builds the daisychess:// variant with the hub URL for self-hosted origins', () => {
    expect(appSetupLink('https://hub.example', 'dc1_a b')).toBe(
      'daisychess://setup?token=dc1_a%20b&hub=wss%3A%2F%2Fhub.example%2Fws',
    );
    expect(appSetupLink('http://localhost:8580', 't')).toBe(
      'daisychess://setup?token=t&hub=ws%3A%2F%2Flocalhost%3A8580%2Fws',
    );
  });

  it('is null for play.daisychess.org (its https link opens the app) and for non-http origins', () => {
    expect(appSetupLink('https://play.daisychess.org', 't')).toBeNull();
    expect(appSetupLink('ftp://hub.example', 't')).toBeNull();
    expect(appSetupLink('not a url', 't')).toBeNull();
  });
});
