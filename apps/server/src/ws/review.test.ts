import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_LARGE_MESSAGE_BYTES,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type ReviewRecordMessage,
  type ReviewStoredMessage,
  type WelcomeMessage,
} from '@daisychess/engine-core';
import { buildApp, type BuildAppOptions } from '../app.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { fakeSpawner, registry, until } from '../../test/helpers.js';
import { fixtureReview, ITALIAN, SCHOLAR, START_FEN } from '../../test/review-fixtures.js';
import { TestClient } from '../../test/ws-client.js';
import { loadSqlite } from '../review/ReviewStore.js';

const TOKEN = 'review-secret';
const sqlite = await loadSqlite();
const apps: FastifyInstance[] = [];
const clients: TestClient[] = [];
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-review-ws-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const c of clients.splice(0)) {
    expect(c.invalid).toEqual([]);
    c.ws.terminate();
  }
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

let n = 0;
async function start(
  config: Partial<Omit<ServerConfig, 'reviewStore'>> & {
    reviewStore?: Partial<ServerConfig['reviewStore']>;
  } = {},
  extra: Partial<BuildAppOptions> = {},
): Promise<{ app: FastifyInstance; url: string }> {
  const base = loadConfig({});
  const app = await buildApp({
    config: {
      ...base,
      accessToken: TOKEN,
      ...config,
      reviewStore: {
        ...base.reviewStore,
        path: path.join(dir, `store-${n++}.sqlite`),
        ...config.reviewStore,
      },
    },
    registry: registry({ id: 'fake', name: 'Fake Engine' }),
    spawnEngine: fakeSpawner({ fake: ['--info-interval=3'] }),
    logger: false,
    ...extra,
  });
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return { app, url: `ws://127.0.0.1:${port}/ws` };
}

async function client(
  url: string,
  token?: string,
  realIp?: string,
): Promise<{ c: TestClient; welcome: WelcomeMessage }> {
  const c = await TestClient.connect(url, realIp ? { headers: { 'x-real-ip': realIp } } : {});
  clients.push(c);
  c.send({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test' },
    ...(token ? { token } : {}),
  });
  const welcome = await c.waitFor((m): m is WelcomeMessage => m.type === 'welcome');
  return { c, welcome };
}

const isStored = (m: { type: string }): m is ReviewStoredMessage => m.type === 'review.stored';
const isRecord = (m: { type: string }): m is ReviewRecordMessage => m.type === 'review.record';

describe.skipIf(!sqlite)('review store over the WebSocket (ADR-017)', () => {
  it('announces the store in welcome.capabilities, for token holders and guests alike', async () => {
    const { url } = await start();
    const { welcome: guest } = await client(url);
    expect(guest.capabilities).toEqual({ analysis: false, rooms: true, reviewStore: true });
    const { welcome: holder } = await client(url, TOKEN);
    expect(holder.capabilities).toEqual({ analysis: true, rooms: true, reviewStore: true });
  });

  it('REVIEW_STORE=off: capabilities.reviewStore is false, writes are `disabled`, reads miss', async () => {
    const { url, app } = await start({ reviewStore: { enabled: false } });
    const { c, welcome } = await client(url, TOKEN);
    expect(welcome.capabilities?.reviewStore).toBe(false);
    const put = fixtureReview(SCHOLAR);
    c.send(put);
    expect(await c.waitFor(isStored)).toMatchObject({ stored: false, reason: 'disabled' });
    c.send({ type: 'review.get', gameKey: put.gameKey, startFen: START_FEN, moves: put.moves });
    expect(await c.waitFor(isRecord)).toEqual({ type: 'review.record', gameKey: put.gameKey, found: false });
    const detail = await app.inject({ method: 'GET', url: '/health/detail' });
    expect(detail.json().reviewStore).toEqual({ enabled: false, reviews: 0, positions: 0, bytes: 0, maxBytes: 0 });
  });

  it('a put without the token is refused, with it stored; a guest on another connection reads it', async () => {
    const { url, app } = await start();
    const put = fixtureReview(ITALIAN, 'deep');
    const { c: guest } = await client(url);
    guest.send(put);
    expect(await guest.waitFor(isStored)).toEqual({
      type: 'review.stored',
      gameKey: put.gameKey,
      stored: false,
      reason: 'unauthorized',
    });
    const { c: holder } = await client(url, TOKEN);
    holder.send(put);
    expect(await holder.waitFor(isStored)).toEqual({ type: 'review.stored', gameKey: put.gameKey, stored: true });
    const { c: reader } = await client(url);
    reader.send({ type: 'review.get', gameKey: put.gameKey, startFen: START_FEN, moves: put.moves });
    const rec = await reader.waitFor(isRecord);
    expect(rec).toMatchObject({ found: true, preset: 'deep', record: put.record });
    expect(typeof rec.createdAt).toBe('number');
    const detail = await app.inject({ method: 'GET', url: '/health/detail' });
    expect(detail.json().reviewStore).toMatchObject({ enabled: true, reviews: 1, positions: 0, maxBytes: 5_000_000_000 });
    expect(detail.json().reviewStore.bytes).toBeGreaterThan(0);
  });

  it('rejects a record offered under a foreign key and a weaker preset after a stronger one', async () => {
    const { url } = await start();
    const { c } = await client(url, TOKEN);
    const deep = fixtureReview(SCHOLAR, 'deep');
    const other = fixtureReview(ITALIAN);
    c.send({ ...deep, gameKey: other.gameKey });
    expect(await c.waitFor(isStored)).toMatchObject({ gameKey: other.gameKey, stored: false, reason: 'key_mismatch' });
    c.send(deep);
    expect(await c.waitFor((m) => isStored(m) && m.gameKey === deep.gameKey)).toMatchObject({ stored: true });
    c.send(fixtureReview(SCHOLAR, 'fast'));
    await until(() => c.messages.filter(isStored).length === 3);
    expect(c.messages.filter(isStored)[2]).toMatchObject({ stored: false, reason: 'superseded' });
  });

  it('positions: a holder writes, a guest reads; unknown FENs are simply absent', async () => {
    const { url } = await start();
    const { c: holder } = await client(url, TOKEN);
    const result = { eval: { cp: 33 }, bestMove: 'e2e4', pv: ['e2e4', 'e7e5'], depth: 25 };
    holder.send({ type: 'review.positions.put', optsKey: 'mt:300', entries: [{ fen: START_FEN, result }] });
    expect(await holder.waitFor((m) => m.type === 'review.positions.stored')).toMatchObject({ stored: true });
    const { c: guest } = await client(url);
    const after = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    guest.send({ type: 'review.positions.get', optsKey: 'mt:300', fens: [START_FEN, after] });
    expect(await guest.waitFor((m) => m.type === 'review.positions')).toEqual({
      type: 'review.positions',
      optsKey: 'mt:300',
      results: { [START_FEN]: result },
    });
    guest.send({ type: 'review.stats.get' });
    expect(await guest.waitFor((m) => m.type === 'review.stats')).toMatchObject({ enabled: true, positions: 1 });
  });

  it('frame sizes: a large review.put passes, a large ping is invalid, above the hard cap the socket closes', async () => {
    const { url } = await start();
    const { c } = await client(url, TOKEN);
    const big = fixtureReview(ITALIAN, 'fast', 'x'.repeat(190));
    // Pad with an unknown field (stripped) so the frame exceeds the ordinary limit.
    const frame = JSON.stringify({ ...big, pad: 'y'.repeat(MAX_MESSAGE_BYTES) });
    expect(frame.length).toBeGreaterThan(MAX_MESSAGE_BYTES);
    c.send(frame);
    expect(await c.waitFor(isStored)).toMatchObject({ stored: true });
    c.send({ type: 'ping', pad: 'x'.repeat(MAX_MESSAGE_BYTES) });
    const err = await c.waitFor((m) => m.type === 'error');
    expect(err).toMatchObject({ code: 'invalid_message', message: `message exceeds ${MAX_MESSAGE_BYTES} bytes` });
    c.send({ type: 'review.put', pad: 'x'.repeat(MAX_LARGE_MESSAGE_BYTES) });
    expect(await c.waitClosed()).toBe(1009);
  });

  it('rate-limits review reads and writes per connection (error rate_limited, socket stays open)', async () => {
    const { url } = await start({}, {
      connection: {
        reviewGetRateLimit: { max: 3, windowMs: 60_000 },
        reviewPutRateLimit: { max: 2, windowMs: 60_000 },
      },
    });
    const { c } = await client(url, TOKEN);
    for (let i = 0; i < 4; i++) c.send({ type: 'review.stats.get' });
    await until(() => c.messages.filter((m) => m.type === 'review.stats').length === 3);
    expect(await c.waitFor((m) => m.type === 'error')).toMatchObject({
      code: 'rate_limited',
      message: 'too many review requests',
    });
    const entries = [{ fen: START_FEN, result: { eval: { cp: 0 } } }];
    for (let i = 0; i < 3; i++) c.send({ type: 'review.positions.put', optsKey: 'd:18', entries });
    await until(() => c.messages.filter((m) => m.type === 'error').length === 2);
    expect(c.messages.filter((m) => m.type === 'error')[1]).toMatchObject({ message: 'too many review writes' });
    expect(c.messages.filter((m) => m.type === 'review.positions.stored')).toHaveLength(2);
    expect(c.closeCode).toBeNull();
  });

  it('caps writes per client address and day (REVIEW_PUT_PER_IP_PER_DAY)', async () => {
    const { url } = await start({ reviewStore: { putPerIpPerDay: 2 }, trustedProxies: '*' });
    const { c } = await client(url, TOKEN, '203.0.113.7');
    const entries = [{ fen: START_FEN, result: { eval: { cp: 0 } } }];
    for (let i = 0; i < 3; i++) c.send({ type: 'review.positions.put', optsKey: 'd:18', entries });
    await until(() => c.messages.filter((m) => m.type === 'review.positions.stored').length === 3);
    expect(c.messages.filter((m) => m.type === 'review.positions.stored').map((m) => (m.type === 'review.positions.stored' ? m.stored : null))).toEqual([true, true, false]);
    expect(c.messages.filter((m) => m.type === 'review.positions.stored')[2]).toMatchObject({ reason: 'quota' });
    // Another address is unaffected.
    const { c: other } = await client(url, TOKEN, '203.0.113.8');
    other.send({ type: 'review.positions.put', optsKey: 'd:18', entries });
    expect(await other.waitFor((m) => m.type === 'review.positions.stored')).toMatchObject({ stored: true });
  });

  it('a public server (no ACCESS_TOKEN) accepts writes from everyone', async () => {
    const { url } = await start({ accessToken: null });
    const { c, welcome } = await client(url);
    expect(welcome.capabilities).toEqual({ analysis: true, rooms: true, reviewStore: true });
    c.send(fixtureReview(SCHOLAR));
    expect(await c.waitFor(isStored)).toMatchObject({ stored: true });
  });
});
