import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as realCrypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToken } from '@daisychess/engine-core';
import { loadSqlite } from '../review/ReviewStore.js';
import type { PoolLogger } from '../engines/EnginePool.js';
import { HubStore, TOUCH_THROTTLE_MS, utcDay } from './store/HubStore.js';
import {
  HubInputError,
  HubTokenService,
  LEGACY_TOKEN_ID,
  LOCAL_NODE_ID,
  POOL_TOKEN_DEFAULT_TTL_MS,
  ROTATION_OVERLAP_MS,
  hashSecret,
  secretHashMatches,
  type HubTokenServiceOptions,
} from './tokens.js';

// Count constant-time comparisons while keeping the real implementation.
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});
const timingSafeEqual = vi.mocked(realCrypto.timingSafeEqual);

const sqlite = await loadSqlite();
const silent: PoolLogger = { info() {}, warn() {}, error() {}, debug() {} };
const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const ACCESS = 'owner-shared-secret-of-adr-010';

let dir: string;
let file: string;
let store: HubStore;
let svc: HubTokenService;
let anna: string;
let bob: string;
let admin: string;

const service = (over: Partial<HubTokenServiceOptions> = {}) =>
  new HubTokenService(store, {
    accessToken: ACCESS,
    poolDailyBudgetMin: 30,
    usageRetentionDays: 90,
    ...over,
  });

const secretOf = (token: string) => parseToken(token)?.secret as string;
/** Same id, different (valid-format) secret. */
const wrongSecret = (token: string) => token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');

describe('secret hashing', () => {
  it('hashes to sha256 hex and compares in constant time', () => {
    const h = hashSecret('abc');
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    timingSafeEqual.mockClear();
    expect(secretHashMatches('abc', h)).toBe(true);
    expect(secretHashMatches('abd', h)).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    // A malformed stored value never matches, but is still compared.
    expect(secretHashMatches('abc', '')).toBe(false);
    expect(secretHashMatches('abc', h.toUpperCase())).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(4);
  });
});

describe.skipIf(!sqlite)('HubTokenService', () => {
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-hubtokens-'));
    file = path.join(dir, 'hub.sqlite');
    store = await HubStore.open({ path: file }, silent);
    svc = service();
    anna = svc.upsertOperator({ lichessId: 'Anna', username: ' Anna ' }, T0).id;
    bob = svc.upsertOperator({ lichessId: 'bob', username: 'Bob' }, T0).id;
    admin = svc.upsertOperator({ lichessId: 'bojan', username: 'bojan' }, T0).id;
    store.setOperatorAdmin(admin, true);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const annaNode = () =>
    svc.mintNode({ operatorId: anna, name: '  fast   box ', pool: true, poolShare: 2 }, T0);

  describe('operators', () => {
    it('normalises the login input and keeps the id on repeat logins', () => {
      const op = store.getOperator(anna);
      expect(op).toMatchObject({ lichessId: 'anna', username: 'Anna' });
      expect(anna).toMatch(/^[a-z2-7]{8}$/);
      expect(svc.upsertOperator({ lichessId: 'anna', username: 'Anna2' }, T0 + 1).id).toBe(anna);
      expect(() => svc.upsertOperator({ lichessId: ' ', username: 'x' })).toThrow(HubInputError);
    });
  });

  describe('player and pool tokens', () => {
    it('mints a player token (plaintext once) and verifies it', () => {
      const node = annaNode().record;
      const { token, record } = svc.mintToken(
        {
          operatorId: anna,
          kind: 'player',
          label: " Anna's  iPad ",
          nodeIds: [node.id],
          poolFallback: true,
        },
        T0,
      );
      expect(parseToken(token)).toEqual({
        kind: 'player',
        id: record.id,
        secret: expect.any(String),
      });
      expect(record).toMatchObject({
        operatorId: anna,
        kind: 'player',
        label: "Anna's iPad",
        nodeIds: [node.id],
        poolFallback: true,
        tier: 'full',
        expiresAt: null,
        revokedAt: null,
        createdAt: T0,
      });
      expect(JSON.stringify(record)).not.toContain(secretOf(token));
      const v = svc.verify(token, T0 + 1);
      expect(v).toEqual({ kind: 'token', record: { ...record, lastUsedAt: T0 + 1 } });
      expect(svc.verifyPlayerToken(token, T0 + 2)).toMatchObject({ kind: 'token' });
      expect(svc.verifyNodeToken(token, T0 + 2)).toEqual({ error: 'bad_token' });
    });

    it('mints pool tokens with a 90-day default expiry and the standard tier', () => {
      const { record } = svc.mintToken({ operatorId: bob, kind: 'pool', poolFallback: true }, T0);
      expect(record).toMatchObject({
        kind: 'pool',
        nodeIds: [],
        poolFallback: false,
        tier: 'standard',
        expiresAt: T0 + POOL_TOKEN_DEFAULT_TTL_MS,
      });
      expect(
        svc.mintToken({ operatorId: bob, kind: 'pool', expiresAt: null, tier: 'small' }, T0).record,
      ).toMatchObject({
        expiresAt: null,
        tier: 'small',
      });
    });

    it('answers bad_token for a wrong secret on an existing id, unknown for an unknown id', () => {
      const { token } = svc.mintToken({ operatorId: bob, kind: 'pool' }, T0);
      expect(svc.verify(wrongSecret(token), T0)).toEqual({ error: 'bad_token' });
      const unknownId = `dc1_${'z'.repeat(8)}_${secretOf(token)}`;
      expect(svc.verify(unknownId, T0)).toEqual({ error: 'unknown' });
    });

    it('answers bad_token for malformed input without touching the store', () => {
      const spy = vi.spyOn(store, 'tokenAuth');
      for (const raw of [
        undefined,
        null,
        42,
        '',
        'dc1_short',
        `dc1_${'A'.repeat(8)}_${'a'.repeat(32)}`,
        `dcx_${'a'.repeat(8)}_${'a'.repeat(32)}`,
      ]) {
        expect(svc.verify(raw, T0)).toEqual({ error: 'bad_token' });
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it('uses the constant-time comparison on every stored-token verification', () => {
      const { token } = svc.mintToken({ operatorId: bob, kind: 'pool' }, T0);
      timingSafeEqual.mockClear();
      svc.verify(token, T0);
      expect(timingSafeEqual).toHaveBeenCalledTimes(1);
      svc.verify(wrongSecret(token), T0);
      expect(timingSafeEqual).toHaveBeenCalledTimes(2);
      // Unknown ids do the same hashing work.
      svc.verify(`dc1_${'z'.repeat(8)}_${secretOf(token)}`, T0);
      expect(timingSafeEqual).toHaveBeenCalledTimes(3);
      // Every call compared two 32-byte digests.
      for (const [a, b] of timingSafeEqual.mock.calls) {
        expect((a as Buffer).length).toBe(32);
        expect((b as Buffer).length).toBe(32);
      }
    });

    it('reports expired tokens (at and after expiresAt), but bad_token wins for a wrong secret', () => {
      const { token } = svc.mintToken({ operatorId: bob, kind: 'pool', expiresAt: T0 + 1_000 }, T0);
      expect(svc.verify(token, T0 + 999)).toMatchObject({ kind: 'token' });
      expect(svc.verify(token, T0 + 1_000)).toEqual({ error: 'expired' });
      expect(svc.verify(wrongSecret(token), T0 + 5_000)).toEqual({ error: 'bad_token' });
    });

    it('reports revoked tokens and tokens of a banned operator, scoped revocation only by the owner', () => {
      const { token, record } = svc.mintToken({ operatorId: bob, kind: 'pool' }, T0);
      expect(svc.revokeToken(record.id, T0, { operatorId: anna })).toBe(false);
      expect(svc.verify(token, T0)).toMatchObject({ kind: 'token' });
      expect(svc.revokeToken(record.id, T0 + 1, { operatorId: bob })).toBe(true);
      expect(svc.verify(token, T0 + 2)).toEqual({ error: 'revoked' });
      // revoked beats expired
      expect(svc.verify(token, T0 + POOL_TOKEN_DEFAULT_TTL_MS + 1)).toEqual({ error: 'revoked' });

      const other = svc.mintToken({ operatorId: bob, kind: 'pool' }, T0);
      store.setOperatorDisabled(bob, true, T0);
      expect(svc.verify(other.token, T0)).toEqual({ error: 'revoked' });
      store.setOperatorDisabled(bob, false, T0);
      expect(svc.verify(other.token, T0)).toMatchObject({ kind: 'token' });
    });

    it('throttles last_used on verification', () => {
      const { token, record } = svc.mintToken({ operatorId: bob, kind: 'pool' }, T0);
      const write = vi.spyOn(store, 'touchToken');
      svc.verify(token, T0);
      svc.verify(token, T0 + MIN);
      expect(store.getToken(record.id)?.lastUsedAt).toBe(T0);
      const later = svc.verify(token, T0 + TOUCH_THROTTLE_MS + 1);
      expect(later).toMatchObject({ record: { lastUsedAt: T0 + TOUCH_THROTTLE_MS + 1 } });
      expect(store.getToken(record.id)?.lastUsedAt).toBe(T0 + TOUCH_THROTTLE_MS + 1);
      expect(write).toHaveBeenCalledTimes(3);
    });

    it('validates minting input', () => {
      const node = annaNode().record;
      const bad = (
        input: Parameters<HubTokenService['mintToken']>[0],
        code: 'invalid' | 'not_found',
      ) => expect(() => svc.mintToken(input, T0)).toThrow(expect.objectContaining({ code }));
      bad({ operatorId: anna, kind: 'player' }, 'invalid'); // no nodes
      bad({ operatorId: anna, kind: 'pool', nodeIds: [node.id] }, 'invalid');
      bad({ operatorId: bob, kind: 'player', nodeIds: [node.id] }, 'not_found'); // foreign node
      bad({ operatorId: anna, kind: 'player', nodeIds: [LOCAL_NODE_ID] }, 'not_found'); // not admin
      bad({ operatorId: anna, kind: 'player', nodeIds: [node.id, node.id] }, 'invalid');
      bad({ operatorId: anna, kind: 'player', nodeIds: ['NOTANID!'] }, 'invalid');
      bad(
        { operatorId: anna, kind: 'player', nodeIds: Array.from({ length: 9 }, () => node.id) },
        'invalid',
      );
      bad({ operatorId: anna, kind: 'pool', label: 'x'.repeat(65) }, 'invalid');
      bad({ operatorId: anna, kind: 'pool', expiresAt: T0 }, 'invalid');
      bad({ operatorId: anna, kind: 'pool', tier: 'huge' as 'full' }, 'invalid');
      bad({ operatorId: anna, kind: 'anonymous' as 'pool' }, 'invalid');
      bad({ operatorId: 'missing0', kind: 'pool' }, 'not_found');
      svc.revokeNode(node.id, T0);
      bad({ operatorId: anna, kind: 'player', nodeIds: [node.id] }, 'not_found'); // revoked node
      store.setOperatorDisabled(anna, true, T0);
      bad({ operatorId: anna, kind: 'pool' }, 'invalid');
      // The administrator may bind tokens to the built-in node.
      expect(
        svc.mintToken({ operatorId: admin, kind: 'player', nodeIds: [LOCAL_NODE_ID] }, T0).record
          .nodeIds,
      ).toEqual([LOCAL_NODE_ID]);
    });

    it('retries minting on an id collision', () => {
      const ids = [new Uint8Array(5), new Uint8Array(5), new Uint8Array(5).fill(1)];
      const random = (size: number) =>
        size === 5 ? (ids.shift() ?? realCrypto.randomBytes(5)) : realCrypto.randomBytes(size);
      const s = service({ random });
      const first = s.mintToken({ operatorId: bob, kind: 'pool' }, T0);
      const second = s.mintToken({ operatorId: bob, kind: 'pool' }, T0);
      expect(first.record.id).toBe('aaaaaaaa');
      expect(second.record.id).not.toBe('aaaaaaaa');
      expect(s.verify(second.token, T0)).toMatchObject({ record: { id: second.record.id } });
      // Persistent collisions give up instead of looping.
      const stuck = service({
        random: (size) => (size === 5 ? new Uint8Array(5) : realCrypto.randomBytes(size)),
      });
      expect(() => stuck.mintToken({ operatorId: bob, kind: 'pool' }, T0)).toThrow(/UNIQUE/);
    });
  });

  describe('node credentials', () => {
    it('mints a node credential and verifies it on both entry points', () => {
      const { token, record } = annaNode();
      expect(parseToken(token)).toMatchObject({ kind: 'node', id: record.id });
      expect(record).toMatchObject({
        operatorId: anna,
        name: 'fast box',
        pool: true,
        poolShare: 2,
        state: 'normal',
      });
      expect(svc.verify(token, T0)).toEqual({ kind: 'node', record });
      expect(svc.verifyNodeToken(token, T0)).toEqual({ kind: 'node', record });
      expect(svc.verifyPlayerToken(token, T0)).toEqual({ error: 'bad_token' });
      expect(svc.verifyNodeToken(wrongSecret(token), T0)).toEqual({ error: 'bad_token' });
      expect(svc.verifyNodeToken(`dcn_${'z'.repeat(8)}_${secretOf(token)}`, T0)).toEqual({
        error: 'unknown',
      });
      expect(svc.verifyNodeToken(ACCESS, T0)).toEqual({ error: 'bad_token' });
      expect(() => svc.mintNode({ operatorId: anna, name: '   ' })).toThrow(HubInputError);
      expect(() => svc.mintNode({ operatorId: anna, name: 'x'.repeat(33) })).toThrow(HubInputError);
      expect(() => svc.mintNode({ operatorId: anna, name: 'x', poolShare: -1 })).toThrow(
        HubInputError,
      );
      expect(() => svc.mintNode({ operatorId: anna, name: 'x', poolShare: 1.5 })).toThrow(
        HubInputError,
      );
    });

    it('rotates with a 24 h overlap: old valid until expiry, then not; new valid throughout', () => {
      const { token: oldToken, record } = annaNode();
      const t1 = T0 + 1_000;
      const rotated = svc.rotateNodeCredential(record.id, t1, { operatorId: anna });
      expect(rotated).toBeDefined();
      const newToken = rotated!.token;
      expect(newToken).not.toBe(oldToken);
      expect(parseToken(newToken)?.id).toBe(record.id);
      expect(rotated!.record.prevExpiresAt).toBe(t1 + ROTATION_OVERLAP_MS);

      expect(svc.verifyNodeToken(oldToken, t1 + ROTATION_OVERLAP_MS - 1)).toMatchObject({
        kind: 'node',
      });
      expect(svc.verifyNodeToken(newToken, t1 + ROTATION_OVERLAP_MS - 1)).toMatchObject({
        kind: 'node',
      });
      expect(svc.verifyNodeToken(oldToken, t1 + ROTATION_OVERLAP_MS)).toEqual({
        error: 'bad_token',
      });
      expect(svc.verifyNodeToken(newToken, t1 + ROTATION_OVERLAP_MS)).toMatchObject({
        kind: 'node',
      });

      // Both credential comparisons always run.
      timingSafeEqual.mockClear();
      svc.verifyNodeToken(newToken, t1);
      expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    });

    it('drops the oldest credential on a second rotation and refuses foreign/revoked rotation', () => {
      const { token: c1, record } = annaNode();
      const c2 = svc.rotateNodeCredential(record.id, T0)!.token;
      const c3 = svc.rotateNodeCredential(record.id, T0 + 1)!.token;
      expect(svc.verifyNodeToken(c1, T0 + 2)).toEqual({ error: 'bad_token' });
      expect(svc.verifyNodeToken(c2, T0 + 2)).toMatchObject({ kind: 'node' });
      expect(svc.verifyNodeToken(c3, T0 + 2)).toMatchObject({ kind: 'node' });
      expect(svc.rotateNodeCredential(record.id, T0, { operatorId: bob })).toBeUndefined();
      expect(svc.rotateNodeCredential('missing0', T0)).toBeUndefined();

      // Revocation is immediate and also kills the overlapping previous credential.
      expect(svc.revokeNode(record.id, T0 + 3, { operatorId: bob })).toBe(false);
      expect(svc.revokeNode(record.id, T0 + 3, { operatorId: anna })).toBe(true);
      expect(svc.verifyNodeToken(c3, T0 + 4)).toEqual({ error: 'revoked' });
      expect(svc.verifyNodeToken(c2, T0 + 4)).toEqual({ error: 'bad_token' });
      expect(() => svc.rotateNodeCredential(record.id, T0 + 5)).toThrow(HubInputError);
    });

    it('treats a disabled node or banned operator as revoked; suspect nodes still verify', () => {
      const { token, record } = annaNode();
      store.updateNode(record.id, { state: 'suspect' });
      expect(svc.verifyNodeToken(token, T0)).toMatchObject({
        kind: 'node',
        record: { state: 'suspect' },
      });
      store.updateNode(record.id, { state: 'disabled' });
      expect(svc.verifyNodeToken(token, T0)).toEqual({ error: 'revoked' });
      store.updateNode(record.id, { state: 'normal' });
      store.setOperatorDisabled(anna, true, T0);
      expect(svc.verifyNodeToken(token, T0)).toEqual({ error: 'revoked' });
    });
  });

  describe('legacy ACCESS_TOKEN', () => {
    it('maps the shared token to a synthetic full-tier token on node local, never stored', () => {
      timingSafeEqual.mockClear();
      const v = svc.verify(ACCESS, T0);
      expect(timingSafeEqual).toHaveBeenCalledTimes(1);
      expect(v).toEqual({
        kind: 'legacy',
        record: expect.objectContaining({
          id: LEGACY_TOKEN_ID,
          operatorId: null,
          kind: 'player',
          nodeIds: [LOCAL_NODE_ID],
          poolFallback: false,
          tier: 'full',
          expiresAt: null,
          revokedAt: null,
        }),
      });
      expect(svc.verifyPlayerToken(ACCESS, T0)).toMatchObject({ kind: 'legacy' });
      expect(Object.isFrozen(svc.legacyToken)).toBe(true);
      expect(store.listTokens()).toEqual([]);
      expect(store.getToken(LEGACY_TOKEN_ID)).toBeUndefined();
    });

    it('rejects other legacy-looking tokens, and all of them when ACCESS_TOKEN is unset', () => {
      expect(svc.verify(ACCESS + 'x', T0)).toEqual({ error: 'bad_token' });
      expect(svc.verify(ACCESS.slice(1), T0)).toEqual({ error: 'bad_token' });
      for (const accessToken of [null, '']) {
        const pub = service({ accessToken });
        expect(pub.verify(ACCESS, T0)).toEqual({ error: 'bad_token' });
        expect(pub.verify('anything', T0)).toEqual({ error: 'bad_token' });
      }
      // A prefixed but malformed token is never treated as legacy.
      const prefixed = service({ accessToken: 'plain' });
      expect(prefixed.verify('dc1_plain', T0)).toEqual({ error: 'bad_token' });
    });

    it('refuses an ACCESS_TOKEN with a reserved prefix and a bad budget setting', () => {
      expect(() => service({ accessToken: 'dc1_whatever' })).toThrow(
        /must not start with dc1_ or dcn_/,
      );
      expect(() => service({ accessToken: 'dcn_whatever' })).toThrow(TypeError);
      expect(() => service({ poolDailyBudgetMin: -1 })).toThrow(RangeError);
    });
  });

  describe('daily pool budget', () => {
    const midnight = Date.UTC(2026, 9, 26); // 2026-10-26T00:00Z

    it('counts engine time against pool tokens per UTC day, split across midnight', () => {
      const { record } = svc.mintToken({ operatorId: bob, kind: 'pool' }, T0);
      const id = record.id;
      expect(svc.dailyBudgetMs).toBe(30 * MIN);
      expect(svc.remainingBudgetMs(id, midnight - 60 * MIN)).toBe(30 * MIN);
      // 20 min search ending 23:50.
      svc.addEngineTime(id, 20 * MIN, { now: midnight - 10 * MIN, nodeId: 'nnnnnnnn' });
      expect(svc.remainingBudgetMs(id, midnight - 10 * MIN)).toBe(10 * MIN);
      // 10 min search 23:55 → 00:05: 5 min on each day.
      svc.addEngineTime(id, 10 * MIN, { now: midnight + 5 * MIN, nodeId: 'nnnnnnnn' });
      expect(svc.remainingBudgetMs(id, midnight - 1)).toBe(5 * MIN);
      expect(svc.remainingBudgetMs(id, midnight + 5 * MIN)).toBe(25 * MIN);
      // Exhausted, never negative.
      svc.addEngineTime(id, 40 * MIN, { now: midnight + 50 * MIN });
      expect(svc.remainingBudgetMs(id, midnight + 50 * MIN)).toBe(0);
      // The next UTC day starts fresh.
      expect(svc.remainingBudgetMs(id, midnight + DAY)).toBe(30 * MIN);

      const rows = store.listUsage({ sinceDay: '2026-10-25', tokenIds: [id] });
      expect(rows).toEqual([
        {
          day: '2026-10-25',
          tokenId: id,
          nodeId: 'nnnnnnnn',
          sessions: 0,
          searches: 1,
          engineMs: 25 * MIN,
        },
        {
          day: '2026-10-26',
          tokenId: id,
          nodeId: '',
          sessions: 0,
          searches: 1,
          engineMs: 40 * MIN,
        },
        {
          day: '2026-10-26',
          tokenId: id,
          nodeId: 'nnnnnnnn',
          sessions: 0,
          searches: 1,
          engineMs: 5 * MIN,
        },
      ]);
    });

    it('splits a long search over several days and accounts zero-length searches', () => {
      const { record } = svc.mintToken({ operatorId: bob, kind: 'pool' }, T0);
      svc.addEngineTime(record.id, DAY + 2 * MIN, { now: midnight + MIN });
      const days = store.listUsage({ sinceDay: '2000-01-01', tokenIds: [record.id] });
      expect(days.map((d) => [d.day, d.engineMs, d.searches])).toEqual([
        ['2026-10-24', MIN, 0],
        ['2026-10-25', DAY, 0],
        ['2026-10-26', MIN, 1],
      ]);
      svc.addEngineTime(record.id, 0, { now: midnight + MIN });
      expect(store.listUsage({ sinceDay: '2026-10-26', tokenIds: [record.id] })[0]?.searches).toBe(
        2,
      );
      expect(() => svc.addEngineTime(record.id, -1)).toThrow(RangeError);
      expect(() => svc.addEngineTime(record.id, Number.NaN)).toThrow(RangeError);
    });

    it('applies only to pool tokens and only when enabled; unknown tokens have none left', () => {
      const node = annaNode().record;
      const player = svc.mintToken(
        { operatorId: anna, kind: 'player', nodeIds: [node.id] },
        T0,
      ).record;
      svc.addEngineTime(player.id, 60 * MIN, { now: T0 });
      expect(svc.remainingBudgetMs(player.id, T0)).toBeNull();
      expect(svc.remainingBudgetMs(LEGACY_TOKEN_ID, T0)).toBeNull();
      expect(svc.remainingBudgetMs('missing0', T0)).toBe(0);
      const pool = svc.mintToken({ operatorId: bob, kind: 'pool' }, T0).record;
      const off = service({ poolDailyBudgetMin: 0 });
      expect(off.dailyBudgetMs).toBeNull();
      expect(off.remainingBudgetMs(pool.id, T0)).toBeNull();
    });

    it('records sessions and purges usage beyond the retention window', () => {
      const pool = svc.mintToken({ operatorId: bob, kind: 'pool' }, T0).record;
      svc.recordSession(pool.id, 'nnnnnnnn', T0);
      svc.recordSession(pool.id, 'nnnnnnnn', T0);
      for (let back = 0; back < 95; back++) svc.addEngineTime(pool.id, 1, { now: T0 - back * DAY });
      expect(store.listUsage({ sinceDay: utcDay(T0), tokenIds: [pool.id] })).toContainEqual(
        expect.objectContaining({ nodeId: 'nnnnnnnn', sessions: 2 }),
      );
      expect(svc.purge(T0)).toEqual({ usage: 5, portalSessions: 0, spotchecks: 0 });
      expect(new Set(store.listUsage({ sinceDay: '2000-01-01' }).map((r) => r.day)).size).toBe(90);
      const short = service({ usageRetentionDays: 1 });
      short.purge(T0);
      expect(store.listUsage({ sinceDay: '2000-01-01' }).every((r) => r.day === utcDay(T0))).toBe(
        true,
      );
    });
  });

  it('never persists a plaintext secret (database and WAL bytes)', async () => {
    const node = annaNode();
    const rotated = svc.rotateNodeCredential(node.record.id, T0)!;
    const player = svc.mintToken(
      { operatorId: anna, kind: 'player', nodeIds: [node.record.id] },
      T0,
    );
    const pool = svc.mintToken({ operatorId: bob, kind: 'pool' }, T0);
    svc.verify(player.token, T0);
    svc.verify(ACCESS, T0);
    const secrets = [node.token, rotated.token, player.token, pool.token].map(secretOf);
    const files = () => [file, `${file}-wal`, `${file}-shm`].filter(existsSync);

    const scan = () => {
      const bytes = Buffer.concat(files().map((f) => readFileSync(f)));
      // Sanity: the scan does see stored values (the hashes).
      expect(bytes.includes(hashSecret(secretOf(player.token)))).toBe(true);
      for (const s of secrets) expect(bytes.includes(s)).toBe(false);
      for (const t of [node.token, rotated.token, player.token, pool.token]) {
        expect(bytes.includes(t)).toBe(false);
      }
      expect(bytes.includes(ACCESS)).toBe(false);
    };
    scan(); // with the WAL still holding the writes
    store.close(); // checkpoint into the main file
    scan();
    store = await HubStore.open({ path: file }, silent);
  });
});
