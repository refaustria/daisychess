import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { PROTOCOL_VERSION } from '@daisychess/engine-core';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { loadSqlite } from './review/ReviewStore.js';
import { LichessError } from './hub/portal/lichess.js';
import { IpHasher, setSharedIpHasher } from './logging/ipHash.js';
import { fakeSpawner, registry, until } from '../test/helpers.js';
import { TestClient } from '../test/ws-client.js';

// Log-capture test (M24-15): representative flows at the default `info` level must leave no raw
// address, no token/secret and no cookie value in any log line.
const sqlite = await loadSqlite();
const ORIGIN = 'https://hub.example';
const CSRF = { origin: ORIGIN, 'x-requested-with': 'daisychess-portal' };
const IPV4 = '198.51.100.7';
const IPV6 = '2001:db8::7';
const SECRETS = [
  'dc1_aaaaaaaa_SECRETSECRETSECRETSECRET',
  'dcn_bbbbbbbb_SECRETSECRETSECRETSECRET',
  'lip_OAUTHCODESECRET',
  'lio_LICHESSTOKENSECRET',
  'COOKIEVALUE123',
  'STANDALONE_ACCESS_SECRET',
];

const apps: FastifyInstance[] = [];
let dir: string | null = null;
const clients: TestClient[] = [];
const hasher = new IpHasher({ now: () => Date.UTC(2026, 9, 25, 12) });
const restore = setSharedIpHasher(hasher);
afterAll(() => void setSharedIpHasher(restore));

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  for (const a of apps.splice(0)) await a.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function capture() {
  const lines: string[] = [];
  return { lines, stream: { write: (l: string) => void lines.push(l) } };
}

function assertClean(lines: string[]): void {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const rec = JSON.parse(line) as { level: number; msg?: string };
    if (rec.level > 30) continue; // never mind debug/trace (not reached at info anyway)
    // Fastify's own "Server listening at http://127.0.0.1:N" is the bind address, not a client.
    const text = rec.msg?.startsWith('Server listening') ? '' : line;
    expect(text).not.toContain(IPV4);
    expect(text).not.toContain(IPV6);
    expect(text).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(text).not.toMatch(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/i);
    expect(line).not.toMatch(/\bd(?:c1|cn)_|\blip_|\blio_/);
    for (const s of SECRETS) expect(line).not.toContain(s);
    expect(line).not.toContain('remoteAddress');
  }
}

async function hello(port: number, ip: string, token?: string) {
  const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws`, {
    headers: { origin: `http://127.0.0.1:${port}`, 'x-real-ip': ip },
  });
  clients.push(c);
  c.send({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test' },
    ...(token === undefined ? {} : { token }),
  });
  await c.waitFor((m) => m.type === 'welcome' || m.type === 'error');
  return c;
}

describe('log hygiene (M24-15)', () => {
  it('standalone: ws connect with and without a bad token, HTTP request with a secret query', async () => {
    const cap = capture();
    const app = await buildApp({
      config: loadConfig({
        REVIEW_STORE: 'off',
        ACCESS_TOKEN: 'STANDALONE_ACCESS_SECRET',
        TRUSTED_PROXIES: '127.0.0.1',
      }),
      registry: registry({ id: 'fake', name: 'Fake' }),
      spawnEngine: fakeSpawner(),
      logStream: cap.stream,
    });
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    await hello(port, IPV4, 'dc1_aaaaaaaa_SECRETSECRETSECRETSECRET');
    const c2 = await hello(port, IPV6);
    c2.ws.close();
    await app.inject({
      method: 'GET',
      url: '/health?code=lip_OAUTHCODESECRET',
      headers: { cookie: 'session=COOKIEVALUE123', 'x-real-ip': IPV4 },
    });
    await until(() => cap.lines.some((l) => l.includes('websocket disconnected')));

    assertClean(cap.lines);
    const joined = cap.lines.join('\n');
    expect(joined).toContain(`"ipHash":"${hasher.hash(IPV4)}"`);
    expect(joined).toContain(`"ipHash":"${hasher.hash(IPV6)}"`);
    expect(joined).toContain('incoming request');
  });

  it.skipIf(!sqlite)(
    'hub: portal login failure, bad player token, /link handshake failure',
    async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-logs-'));
      const cap = capture();
      const app = await buildApp({
        config: loadConfig({
          ROLE: 'hub',
          HUB_STORE_PATH: path.join(dir, 'hub.sqlite'),
          REVIEW_STORE: 'off',
          HUB_ADMIN_LICHESS: 'bojan',
          PUBLIC_ORIGIN: ORIGIN,
          HUB_LOCAL_POOL_SHARE: '0',
          TRUSTED_PROXIES: '127.0.0.1',
        }),
        registry: registry({ id: 'fake', name: 'Fake' }),
        spawnEngine: fakeSpawner(),
        logStream: cap.stream,
        portal: {
          fetchAccount: async () => {
            throw new LichessError('rejected', 'lichess said no to lio_LICHESSTOKENSECRET');
          },
        },
      });
      apps.push(app);
      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server.address() as AddressInfo).port;

      const login = await app.inject({
        method: 'POST',
        url: '/api/portal/login',
        headers: { ...CSRF, cookie: 'dc_portal=COOKIEVALUE123', 'x-real-ip': IPV4 },
        payload: { lichessToken: 'lio_LICHESSTOKENSECRET' },
      });
      expect(login.statusCode).toBeGreaterThanOrEqual(400);

      await hello(port, IPV4, 'dc1_aaaaaaaa_SECRETSECRETSECRETSECRET');

      const link = new WebSocket(`ws://127.0.0.1:${port}/link`, { headers: { 'x-real-ip': IPV6 } });
      await new Promise<void>((resolve, reject) => {
        link.once('open', () => {
          link.send(
            JSON.stringify({
              type: 'node.hello',
              linkVersion: 1,
              nodeToken: 'dcn_bbbbbbbb_SECRETSECRETSECRETSECRET',
              node: { version: '0.3.0', platform: 'linux', arch: 'x64' },
              engines: [],
              limits: {},
              maxSessions: 1,
              pool: false,
            }),
          );
        });
        link.once('close', () => resolve());
        link.once('error', reject);
      });
      await until(() => cap.lines.some((l) => l.includes('link:')));

      assertClean(cap.lines);
      const joined = cap.lines.join('\n');
      expect(joined).toContain(`"ipHash":"${hasher.hash(IPV6)}"`);
    },
  );
});
