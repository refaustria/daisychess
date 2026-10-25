import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSqlite } from '../../review/ReviewStore.js';
import type { PoolLogger } from '../../engines/EnginePool.js';
import {
  HubStore,
  TOUCH_THROTTLE_MS,
  SPOTCHECK_RETENTION_MS,
  utcDay,
  utcDayStart,
  type NewTokenRow,
} from './HubStore.js';
import { HUB_MIGRATIONS } from './schema.js';
import { base32, randomBase32 } from './ids.js';

const sqlite = await loadSqlite();
const silent: PoolLogger = { info() {}, warn() {}, error() {}, debug() {} };
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const LATEST = HUB_MIGRATIONS.length;

let dir: string;
let file: string;
let store: HubStore;

const open = (opts?: Parameters<typeof HubStore.open>[2]) =>
  HubStore.open({ path: file }, silent, opts);

function tokenRow(over: Partial<NewTokenRow> = {}): NewTokenRow {
  return {
    id: 'tttttttt',
    operatorId: 'op1op1op',
    kind: 'player',
    secretHash: HASH_A,
    label: 'Anna',
    nodeIds: ['nnnnnnnn'],
    poolFallback: true,
    tier: 'standard',
    expiresAt: null,
    createdAt: T0,
    ...over,
  };
}

describe('ids', () => {
  it('encodes RFC 4648 base32 vectors in lowercase without padding', () => {
    const enc = (s: string) => base32(Buffer.from(s, 'utf8'));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('my');
    expect(enc('fo')).toBe('mzxq');
    expect(enc('foo')).toBe('mzxw6');
    expect(enc('foobar')).toBe('mzxw6ytboi');
    expect(base32(new Uint8Array(5).fill(255))).toBe('77777777');
  });

  it('produces random ids of full-entropy length and rejects other lengths', () => {
    expect(randomBase32(8)).toMatch(/^[a-z2-7]{8}$/);
    expect(randomBase32(32)).toMatch(/^[a-z2-7]{32}$/);
    expect(randomBase32(8, () => new Uint8Array(5))).toBe('aaaaaaaa');
    expect(() => randomBase32(7)).toThrow(TypeError);
    expect(() => randomBase32(0)).toThrow(TypeError);
  });

  it('computes UTC days', () => {
    expect(utcDay(T0)).toBe('2026-10-25');
    expect(utcDay(Date.UTC(2026, 9, 25, 23, 59, 59, 999))).toBe('2026-10-25');
    expect(utcDay(Date.UTC(2026, 9, 26))).toBe('2026-10-26');
    expect(utcDayStart(T0)).toBe(Date.UTC(2026, 9, 25));
  });
});

describe('HubStore without node:sqlite', () => {
  it('rejects with a clear error', async () => {
    await expect(
      HubStore.open({ path: '/nonexistent/hub.sqlite' }, silent, { loadSqlite: async () => null }),
    ).rejects.toThrow(/node:sqlite is not available \(Node >= 22\.13 required/);
  });
});

describe.skipIf(!sqlite)('HubStore (SQLite)', () => {
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-hub-'));
    file = path.join(dir, 'nested', 'hub.sqlite');
    store = await open();
    store.upsertOperator({ lichessId: 'anna', username: 'Anna', newId: 'op1op1op' }, T0);
    store.upsertOperator({ lichessId: 'bob', username: 'Bob', newId: 'op2op2op' }, T0);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('migrations', () => {
    it('applies every migration once; reopening is idempotent and keeps the data', async () => {
      expect(store.schemaVersion()).toBe(HUB_MIGRATIONS.length);
      store.insertToken(tokenRow());
      store.close();
      store = await open();
      expect(store.schemaVersion()).toBe(LATEST);
      expect(store.getToken('tttttttt')?.label).toBe('Anna');
      store.close();
      // A third open with an explicit list of the same migrations applies nothing either.
      store = await open({ migrations: HUB_MIGRATIONS });
      expect(store.schemaVersion()).toBe(LATEST);
      expect(store.listTokens()).toHaveLength(1);
    });

    it('runs WAL and enforces foreign keys', () => {
      const raw = new sqlite!.DatabaseSync(file);
      expect(raw.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      raw.close();
      expect(() => store.insertToken(tokenRow({ operatorId: 'nobody00' }))).toThrow(/FOREIGN KEY/);
    });

    it('applies a later migration on reopen, in order', async () => {
      store.close();
      const next = { version: LATEST + 1, name: 'extra', sql: 'CREATE TABLE extra (a INTEGER);' };
      store = await open({ migrations: [next, ...HUB_MIGRATIONS] });
      expect(store.schemaVersion()).toBe(LATEST + 1);
      store.close();
      store = await open({ migrations: [...HUB_MIGRATIONS, next] });
      expect(store.schemaVersion()).toBe(LATEST + 1);
    });

    it('v2 (M24-12) upgrades a v1 file: nodes keep their data and are not pool-banned', async () => {
      store.close();
      for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
      store = await open({ migrations: HUB_MIGRATIONS.slice(0, 1) });
      expect(store.schemaVersion()).toBe(1);
      store.close();
      const raw = new sqlite!.DatabaseSync(file);
      raw
        .prepare(
          "INSERT INTO operators (id, lichess_id, username, created_at) VALUES ('op1op1op', 'anna', 'Anna', 0)",
        )
        .run();
      raw
        .prepare(
          "INSERT INTO nodes (id, operator_id, name, secret_hash, pool, pool_share, created_at) VALUES ('nnnnnnnn', 'op1op1op', 'box', ?, 1, 2, 0)",
        )
        .run(HASH_A);
      raw.close();
      store = await open();
      expect(store.schemaVersion()).toBe(2);
      expect(store.getNode('nnnnnnnn')).toMatchObject({
        name: 'box',
        pool: true,
        poolBannedAt: null,
        poolBanReason: null,
      });
    });

    it('rolls a failing migration back completely and reports it', async () => {
      store.close();
      const bad = {
        version: LATEST + 1,
        name: 'broken',
        sql: 'CREATE TABLE half (a INTEGER); THIS IS NOT SQL;',
      };
      await expect(open({ migrations: [...HUB_MIGRATIONS, bad] })).rejects.toThrow(
        new RegExp(`migration ${LATEST + 1} \\(broken\\) failed`),
      );
      store = await open();
      expect(store.schemaVersion()).toBe(LATEST);
      const raw = new sqlite!.DatabaseSync(file);
      expect(
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half'").get(),
      ).toBeUndefined();
      raw.close();
    });

    it('refuses a file written by a newer schema, and gapped migration lists', async () => {
      store.close();
      const raw = new sqlite!.DatabaseSync(file);
      raw
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(7, 'future', 0);
      raw.close();
      await expect(open()).rejects.toThrow(
        new RegExp(`schema version 7 is newer than this server supports \\(${LATEST}\\)`),
      );
      await expect(open({ migrations: [{ version: 3, name: 'gap', sql: '' }] })).rejects.toThrow(
        /without gaps/,
      );
      const fresh = path.join(dir, 'fresh.sqlite');
      store = await HubStore.open({ path: fresh }, silent);
    });

    it('stores no IP or e-mail columns anywhere', () => {
      const raw = new sqlite!.DatabaseSync(file);
      const cols = raw
        .prepare(
          "SELECT m.name AS t, p.name AS c FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table'",
        )
        .all()
        .map((r) => `${String(r.t)}.${String(r.c)}`);
      raw.close();
      expect(cols.length).toBeGreaterThan(40);
      expect(cols.filter((c) => /ip|addr|mail/i.test(c.split('.')[1] ?? ''))).toEqual([]);
    });
  });

  describe('operators', () => {
    it('upserts by lichess id (login), keeps the id, updates username and last login', () => {
      const first = store.getOperatorByLichessId('anna');
      expect(first).toMatchObject({
        id: 'op1op1op',
        username: 'Anna',
        admin: false,
        createdAt: T0,
      });
      const again = store.upsertOperator(
        { lichessId: 'anna', username: 'AnnaK', newId: 'ignored0' },
        T0 + 1000,
      );
      expect(again).toMatchObject({
        id: 'op1op1op',
        username: 'AnnaK',
        lastLoginAt: T0 + 1000,
        createdAt: T0,
      });
      expect(store.getOperator('ignored0')).toBeUndefined();
      expect(store.setOperatorAdmin('op1op1op', true)).toBe(true);
      expect(store.setOperatorDisabled('op1op1op', true, T0 + 5)).toBe(true);
      expect(store.getOperator('op1op1op')).toMatchObject({ admin: true, disabledAt: T0 + 5 });
      expect(store.setOperatorDisabled('op1op1op', false, T0 + 6)).toBe(true);
      expect(store.getOperator('op1op1op')?.disabledAt).toBeNull();
      expect(store.setOperatorAdmin('missing0', true)).toBe(false);
    });
  });

  describe('nodes', () => {
    beforeEach(() => {
      store.insertNode({
        id: 'nnnnnnnn',
        operatorId: 'op1op1op',
        name: 'fast-box',
        secretHash: HASH_A,
        pool: true,
        poolShare: 2,
        createdAt: T0,
      });
    });

    it('reads, lists and updates nodes scoped by operator', () => {
      expect(store.getNode('nnnnnnnn')).toMatchObject({
        id: 'nnnnnnnn',
        operatorId: 'op1op1op',
        name: 'fast-box',
        pool: true,
        poolShare: 2,
        state: 'normal',
        revokedAt: null,
        prevExpiresAt: null,
        poolBannedAt: null,
        poolBanReason: null,
      });
      expect(store.setPoolBan('nnnnnnnn', { at: T0, reason: 'spot-check failures' })).toMatchObject(
        { poolBannedAt: T0, poolBanReason: 'spot-check failures', pool: true, state: 'normal' },
      );
      expect(store.setPoolBan('nnnnnnnn', null)).toMatchObject({
        poolBannedAt: null,
        poolBanReason: null,
      });
      expect(store.setPoolBan('zzzzzzzz', null)).toBeUndefined();
      expect(store.getNode('nnnnnnnn', { operatorId: 'op2op2op' })).toBeUndefined();
      expect(store.listNodes({ operatorId: 'op2op2op' })).toEqual([]);
      expect(store.listNodes({ operatorId: 'op1op1op' })).toHaveLength(1);
      expect(store.listNodes()).toHaveLength(1);
      expect(
        store.updateNode('nnnnnnnn', { name: 'x' }, { operatorId: 'op2op2op' }),
      ).toBeUndefined();
      expect(store.updateNode('nnnnnnnn', { pool: false, state: 'suspect' })).toMatchObject({
        name: 'fast-box',
        pool: false,
        poolShare: 2,
        state: 'suspect',
      });
      expect(() => store.updateNode('nnnnnnnn', { state: 'weird' as 'normal' })).toThrow(/CHECK/);
      expect(store.revokeNode('nnnnnnnn', T0, { operatorId: 'op2op2op' })).toBe(false);
      expect(store.revokeNode('nnnnnnnn', T0 + 1)).toBe(true);
      expect(store.revokeNode('nnnnnnnn', T0 + 2)).toBe(true);
      expect(store.getNode('nnnnnnnn')?.revokedAt).toBe(T0 + 1);
    });

    it('keeps credential hashes out of every read API', () => {
      store.setNodeCredential('nnnnnnnn', {
        secretHash: HASH_B,
        secretHashPrev: HASH_A,
        prevExpiresAt: T0 + DAY,
      });
      const reads = [
        store.getNode('nnnnnnnn'),
        store.listNodes(),
        store.listNodes({ operatorId: 'op1op1op' }),
      ];
      for (const r of reads) {
        const json = JSON.stringify(r);
        expect(json).not.toContain(HASH_A);
        expect(json).not.toContain(HASH_B);
        expect(json).not.toMatch(/hash/i);
      }
      expect(store.nodeAuth('nnnnnnnn')).toMatchObject({
        secretHash: HASH_B,
        secretHashPrev: HASH_A,
        operatorDisabled: false,
        record: { prevExpiresAt: T0 + DAY },
      });
      expect(store.nodeAuth('missing0')).toBeUndefined();
    });

    it('throttles last_seen writes unless the version or session count changes', () => {
      expect(store.markNodeSeen('nnnnnnnn', T0, { version: '1.0.0', maxSessions: 4 })).toBe(true);
      expect(
        store.markNodeSeen('nnnnnnnn', T0 + 10_000, { version: '1.0.0', maxSessions: 4 }),
      ).toBe(false);
      expect(store.markNodeSeen('nnnnnnnn', T0 + 20_000)).toBe(false);
      expect(store.markNodeSeen('nnnnnnnn', T0 + 30_000, { version: '1.1.0' })).toBe(true);
      expect(store.markNodeSeen('nnnnnnnn', T0 + 40_000, { maxSessions: 8 })).toBe(true);
      expect(store.getNode('nnnnnnnn')).toMatchObject({
        lastSeenAt: T0 + 40_000,
        lastVersion: '1.1.0',
        maxSessionsSeen: 8,
      });
      expect(store.markNodeSeen('nnnnnnnn', T0 + 40_000 + TOUCH_THROTTLE_MS)).toBe(true);
      expect(store.getNode('nnnnnnnn')?.lastVersion).toBe('1.1.0');
    });

    it('reports a disabled operator in nodeAuth', () => {
      store.setOperatorDisabled('op1op1op', true, T0);
      expect(store.nodeAuth('nnnnnnnn')?.operatorDisabled).toBe(true);
    });
  });

  describe('tokens', () => {
    it('round-trips a token row and keeps the hash out of read APIs', () => {
      store.insertToken(tokenRow({ nodeIds: ['nnnnnnnn', 'local'] }));
      const rec = store.getToken('tttttttt');
      expect(rec).toEqual({
        id: 'tttttttt',
        operatorId: 'op1op1op',
        kind: 'player',
        label: 'Anna',
        nodeIds: ['nnnnnnnn', 'local'],
        poolFallback: true,
        tier: 'standard',
        expiresAt: null,
        revokedAt: null,
        createdAt: T0,
        lastUsedAt: null,
      });
      for (const r of [rec, store.listTokens(), store.listTokens({ operatorId: 'op1op1op' })]) {
        expect(JSON.stringify(r)).not.toContain(HASH_A);
        expect(JSON.stringify(r)).not.toMatch(/hash/i);
      }
      expect(store.tokenAuth('tttttttt')).toMatchObject({
        secretHash: HASH_A,
        operatorDisabled: false,
      });
      expect(() => store.insertToken(tokenRow())).toThrow(/UNIQUE constraint failed: tokens\.id/);
      expect(() =>
        store.insertToken(tokenRow({ id: 'kkkkkkkk', kind: 'user' as 'player' })),
      ).toThrow(/CHECK/);
      expect(() => store.insertToken(tokenRow({ id: 'kkkkkkkk', tier: 'max' as 'full' }))).toThrow(
        /CHECK/,
      );
    });

    it('scopes reads and writes by operator (another operator sees nothing)', () => {
      store.insertToken(tokenRow());
      store.insertToken(
        tokenRow({ id: 'uuuuuuuu', operatorId: 'op2op2op', kind: 'pool', nodeIds: [] }),
      );
      const bob = { operatorId: 'op2op2op' };
      expect(store.getToken('tttttttt', bob)).toBeUndefined();
      expect(store.listTokens(bob).map((t) => t.id)).toEqual(['uuuuuuuu']);
      expect(store.listTokens().map((t) => t.id)).toEqual(['tttttttt', 'uuuuuuuu']);
      expect(store.updateToken('tttttttt', { label: 'hijack' }, bob)).toBeUndefined();
      expect(store.revokeToken('tttttttt', T0, bob)).toBe(false);
      expect(store.getToken('tttttttt')).toMatchObject({ label: 'Anna', revokedAt: null });
      expect(store.countLiveTokens('op2op2op', 'pool', T0)).toBe(1);
      expect(store.countLiveTokens('op1op1op', 'pool', T0)).toBe(0);
    });

    it('updates fields selectively, including clearing the expiry', () => {
      store.insertToken(tokenRow({ expiresAt: T0 + DAY }));
      expect(
        store.updateToken('tttttttt', {
          label: 'Anna iPad',
          nodeIds: [],
          poolFallback: false,
          tier: 'small',
        }),
      ).toMatchObject({
        label: 'Anna iPad',
        nodeIds: [],
        poolFallback: false,
        tier: 'small',
        expiresAt: T0 + DAY,
      });
      expect(store.updateToken('tttttttt', { expiresAt: null })?.expiresAt).toBeNull();
      expect(store.updateToken('missing0', { label: 'x' })).toBeUndefined();
    });

    it('revokes idempotently and counts revoked/expired tokens as not live', () => {
      store.insertToken(tokenRow({ kind: 'pool', nodeIds: [] }));
      store.insertToken(
        tokenRow({ id: 'eeeeeeee', kind: 'pool', nodeIds: [], expiresAt: T0 + 10 }),
      );
      expect(store.countLiveTokens('op1op1op', 'pool', T0)).toBe(2);
      expect(store.countLiveTokens('op1op1op', 'pool', T0 + 10)).toBe(1);
      expect(store.revokeToken('tttttttt', T0 + 1)).toBe(true);
      expect(store.revokeToken('tttttttt', T0 + 2)).toBe(true);
      expect(store.getToken('tttttttt')?.revokedAt).toBe(T0 + 1);
      expect(store.countLiveTokens('op1op1op', 'pool', T0)).toBe(1);
      expect(store.revokeToken('missing0', T0)).toBe(false);
    });

    it('throttles last_used writes', () => {
      store.insertToken(tokenRow());
      expect(store.touchToken('tttttttt', T0)).toBe(true);
      expect(store.touchToken('tttttttt', T0 + 1_000)).toBe(false);
      expect(store.touchToken('tttttttt', T0 + TOUCH_THROTTLE_MS - 1)).toBe(false);
      expect(store.getToken('tttttttt')?.lastUsedAt).toBe(T0);
      expect(store.touchToken('tttttttt', T0 + TOUCH_THROTTLE_MS)).toBe(true);
      expect(store.getToken('tttttttt')?.lastUsedAt).toBe(T0 + TOUCH_THROTTLE_MS);
      expect(store.touchToken('missing0', T0)).toBe(false);
    });

    it('tolerates a corrupt node_ids column', () => {
      store.insertToken(tokenRow());
      const raw = new sqlite!.DatabaseSync(file);
      raw.prepare("UPDATE tokens SET node_ids = 'not json' WHERE id = ?").run('tttttttt');
      raw.close();
      expect(store.getToken('tttttttt')?.nodeIds).toEqual([]);
    });
  });

  describe('usage and retention', () => {
    it('accumulates per (day, token, node) and filters listings', () => {
      store.addUsage({ day: '2026-10-25', tokenId: 'tttttttt', nodeId: 'nnnnnnnn', sessions: 1 });
      store.addUsage({
        day: '2026-10-25',
        tokenId: 'tttttttt',
        nodeId: 'nnnnnnnn',
        searches: 2,
        engineMs: 500,
      });
      store.addUsage({ day: '2026-10-25', tokenId: 'tttttttt', engineMs: 100 });
      store.addUsage({ day: '2026-10-24', tokenId: 'tttttttt', engineMs: 7 });
      store.addUsage({ day: '2026-10-25', tokenId: 'uuuuuuuu', nodeId: 'mmmmmmmm', engineMs: 1 });
      expect(store.engineMsOn('tttttttt', '2026-10-25')).toBe(600);
      expect(store.engineMsOn('tttttttt', '2026-10-24')).toBe(7);
      expect(store.engineMsOn('nobody00', '2026-10-25')).toBe(0);
      expect(store.listUsage({ sinceDay: '2026-10-25', tokenIds: ['tttttttt'] })).toEqual([
        {
          day: '2026-10-25',
          tokenId: 'tttttttt',
          nodeId: '',
          sessions: 0,
          searches: 0,
          engineMs: 100,
        },
        {
          day: '2026-10-25',
          tokenId: 'tttttttt',
          nodeId: 'nnnnnnnn',
          sessions: 1,
          searches: 2,
          engineMs: 500,
        },
      ]);
      expect(store.listUsage({ sinceDay: '2026-01-01', nodeIds: ['mmmmmmmm'] })).toHaveLength(1);
      expect(store.listUsage({ sinceDay: '2026-01-01' })).toHaveLength(4);
      expect(store.listUsage({ sinceDay: '2026-01-01', tokenIds: [] })).toEqual([]);
      expect(() => store.addUsage({ day: '2026-10-25', tokenId: 't', engineMs: -1 })).toThrow(
        RangeError,
      );
      expect(() => store.addUsage({ day: '2026-10-25', tokenId: 't', engineMs: 1.5 })).toThrow(
        RangeError,
      );
      expect(() => store.addUsage({ day: '25.10.2026', tokenId: 't' })).toThrow(RangeError);
    });

    it('purges usage beyond the retention window, expired portal sessions and old spot-checks', () => {
      for (let back = 0; back < 100; back++) {
        store.addUsage({ day: utcDay(T0 - back * DAY), tokenId: 'tttttttt', engineMs: 1 });
      }
      store.insertNode({
        id: 'nnnnnnnn',
        operatorId: 'op1op1op',
        name: 'n',
        secretHash: HASH_A,
        pool: false,
        poolShare: 0,
        createdAt: T0,
      });
      const raw = new sqlite!.DatabaseSync(file);
      raw.exec('PRAGMA foreign_keys = ON');
      const ps = raw.prepare(
        'INSERT INTO portal_sessions (id_hash, operator_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      );
      ps.run(HASH_A, 'op1op1op', T0 - DAY, T0 - 1);
      ps.run(HASH_B, 'op1op1op', T0 - DAY, T0 + DAY);
      const sc = raw.prepare('INSERT INTO spotchecks (node_id, at, agreed) VALUES (?, ?, ?)');
      sc.run('nnnnnnnn', T0 - SPOTCHECK_RETENTION_MS - 1, 1);
      sc.run('nnnnnnnn', T0 - 1_000, 0);
      raw.close();

      expect(store.purgeExpired(T0, 90)).toEqual({ usage: 10, portalSessions: 1, spotchecks: 1 });
      const left = store.listUsage({ sinceDay: '2000-01-01' });
      expect(left).toHaveLength(90);
      expect(left[0]?.day).toBe(utcDay(T0 - 89 * DAY));
      expect(store.purgeExpired(T0, 90)).toEqual({ usage: 0, portalSessions: 0, spotchecks: 0 });
      // Just after midnight the oldest kept day drops out.
      expect(store.purgeExpired(utcDayStart(T0) + DAY, 90).usage).toBe(1);
      expect(() => store.purgeExpired(T0, 0)).toThrow(RangeError);
    });
  });
});
