import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSqlite } from '../review/ReviewStore.js';
import type { PoolLogger } from '../engines/EnginePool.js';
import { HubStore } from './store/HubStore.js';
import { HubInputError, HubTokenService, LOCAL_NODE_ID } from './tokens.js';

const sqlite = await loadSqlite();
const silent: PoolLogger = { info() {}, warn() {}, error() {}, debug() {} };
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);

let dir: string;
let store: HubStore;
let svc: HubTokenService;
let anna: string;
let bob: string;
let admin: string;

describe.skipIf(!sqlite)('hub store and token service: portal operations (M24-9)', () => {
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-hubportal-'));
    store = await HubStore.open({ path: path.join(dir, 'hub.sqlite') }, silent);
    svc = new HubTokenService(store, {
      accessToken: null,
      poolDailyBudgetMin: 30,
      usageRetentionDays: 90,
    });
    anna = svc.upsertOperator({ lichessId: 'anna', username: 'Anna' }, T0).id;
    bob = svc.upsertOperator({ lichessId: 'bob', username: 'Bob' }, T0).id;
    admin = svc.upsertOperator({ lichessId: 'bojan', username: 'bojan' }, T0).id;
    store.setOperatorAdmin(admin, true);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('portal sessions: stored by hash, expire, deleted singly or per operator', () => {
    store.insertPortalSession({
      idHash: 'h1',
      operatorId: anna,
      createdAt: T0,
      expiresAt: T0 + DAY,
    });
    store.insertPortalSession({
      idHash: 'h2',
      operatorId: anna,
      createdAt: T0,
      expiresAt: T0 + DAY,
    });
    store.insertPortalSession({
      idHash: 'h3',
      operatorId: bob,
      createdAt: T0,
      expiresAt: T0 + DAY,
    });
    expect(store.getPortalSession('h1', T0)).toEqual({
      idHash: 'h1',
      operatorId: anna,
      createdAt: T0,
      expiresAt: T0 + DAY,
    });
    expect(store.getPortalSession('h1', T0 + DAY)).toBeUndefined();
    expect(store.getPortalSession('nope', T0)).toBeUndefined();
    expect(store.deletePortalSession('h1')).toBe(true);
    expect(store.deletePortalSession('h1')).toBe(false);
    expect(store.deletePortalSessionsOf(anna)).toBe(1);
    expect(store.getPortalSession('h3', T0)).toBeDefined();
    expect(store.purgeExpired(T0 + DAY, 90).portalSessions).toBe(1);
  });

  it('listOperators, countActiveNodes and countAllLiveTokens', () => {
    expect(
      store
        .listOperators()
        .map((o) => o.username)
        .sort(),
    ).toEqual(['Anna', 'Bob', 'bojan']);
    const n1 = svc.mintNode({ operatorId: anna, name: 'one' }, T0).record.id;
    svc.mintNode({ operatorId: anna, name: 'two' }, T0);
    svc.mintNode({ operatorId: bob, name: 'bobs' }, T0);
    expect(store.countActiveNodes(anna)).toBe(2);
    svc.revokeNode(n1, T0);
    expect(store.countActiveNodes(anna)).toBe(1);

    svc.mintToken({ operatorId: anna, kind: 'pool' }, T0);
    svc.mintToken({ operatorId: anna, kind: 'pool', expiresAt: T0 + 1_000 }, T0);
    const p = svc.mintToken({ operatorId: anna, kind: 'pool' }, T0).record.id;
    svc.revokeToken(p, T0);
    expect(store.countAllLiveTokens(anna, T0)).toBe(2);
    expect(store.countAllLiveTokens(anna, T0 + 1_000)).toBe(1);
    expect(store.countAllLiveTokens(bob, T0)).toBe(0);
  });

  it('deleteNode removes the node from token node lists and respects the scope', () => {
    const a = svc.mintNode({ operatorId: anna, name: 'a' }, T0).record.id;
    const b = svc.mintNode({ operatorId: anna, name: 'b' }, T0).record.id;
    const tok = svc.mintToken({ operatorId: anna, kind: 'player', nodeIds: [a, b] }, T0).record.id;
    expect(svc.deleteNode(a, { operatorId: bob })).toBe(false);
    expect(store.getNode(a)).toBeDefined();
    expect(svc.deleteNode(a, { operatorId: anna })).toBe(true);
    expect(store.getNode(a)).toBeUndefined();
    expect(store.getToken(tok)?.nodeIds).toEqual([b]);
    expect(svc.deleteNode(a)).toBe(false);
    // The deleted node's credential is gone with the row.
    expect(store.nodeAuth(a)).toBeUndefined();
  });

  it('updateNode validates name and pool share, is scoped, refuses revoked nodes', () => {
    const id = svc.mintNode({ operatorId: anna, name: 'box' }, T0).record.id;
    expect(
      svc.updateNode(id, { name: '  fast   box ', pool: true, poolShare: 3 }, { operatorId: anna }),
    ).toMatchObject({
      name: 'fast box',
      pool: true,
      poolShare: 3,
    });
    expect(svc.updateNode(id, { name: 'x' }, { operatorId: bob })).toBeUndefined();
    expect(() => svc.updateNode(id, { name: '   ' })).toThrow(HubInputError);
    expect(() => svc.updateNode(id, { name: 'x'.repeat(33) })).toThrow(HubInputError);
    expect(() => svc.updateNode(id, { poolShare: -1 })).toThrow(HubInputError);
    expect(() => svc.updateNode(id, { poolShare: 1.5 })).toThrow(HubInputError);
    svc.revokeNode(id, T0);
    expect(() => svc.updateNode(id, { name: 'y' })).toThrow(/revoked/);
  });

  it('updateToken validates like mintToken and is scoped', () => {
    const n1 = svc.mintNode({ operatorId: anna, name: 'a' }, T0).record.id;
    const n2 = svc.mintNode({ operatorId: anna, name: 'b' }, T0).record.id;
    const bobs = svc.mintNode({ operatorId: bob, name: 'bobs' }, T0).record.id;
    const t = svc.mintToken({ operatorId: anna, kind: 'player', nodeIds: [n1] }, T0).record.id;
    expect(
      svc.updateToken(
        t,
        { label: ' iPad ', nodeIds: [n2, n1], poolFallback: true, tier: 'small' },
        T0,
        {
          operatorId: anna,
        },
      ),
    ).toMatchObject({ label: 'iPad', nodeIds: [n2, n1], poolFallback: true, tier: 'small' });
    expect(svc.updateToken(t, { label: 'x' }, T0, { operatorId: bob })).toBeUndefined();
    // Another operator's node behaves like a missing one.
    expect(() => svc.updateToken(t, { nodeIds: [bobs] }, T0)).toThrow(/not found/);
    expect(() => svc.updateToken(t, { nodeIds: [] }, T0)).toThrow(/at least one node/);
    expect(() => svc.updateToken(t, { nodeIds: [LOCAL_NODE_ID] }, T0)).toThrow(/not found/);
    expect(() => svc.updateToken(t, { expiresAt: T0 }, T0)).toThrow(/future/);
    expect(svc.updateToken(t, { expiresAt: T0 + DAY }, T0)?.expiresAt).toBe(T0 + DAY);
    expect(svc.updateToken(t, { expiresAt: null }, T0)?.expiresAt).toBeNull();
    expect(() => svc.updateToken(t, { label: 'y'.repeat(65) }, T0)).toThrow(HubInputError);

    const pool = svc.mintToken({ operatorId: anna, kind: 'pool' }, T0).record.id;
    expect(() => svc.updateToken(pool, { nodeIds: [n1] }, T0)).toThrow(/pool token/);
    expect(() => svc.updateToken(pool, { poolFallback: true }, T0)).toThrow(/pool token/);
    expect(svc.updateToken(pool, { tier: 'small' }, T0)?.tier).toBe('small');

    // The administrator may list the built-in node.
    const own = svc.mintToken({ operatorId: admin, kind: 'player', nodeIds: [LOCAL_NODE_ID] }, T0)
      .record.id;
    expect(svc.updateToken(own, { nodeIds: [LOCAL_NODE_ID] }, T0)?.nodeIds).toEqual([
      LOCAL_NODE_ID,
    ]);

    svc.revokeToken(t, T0);
    expect(() => svc.updateToken(t, { label: 'z' }, T0)).toThrow(/revoked/);
  });

  it('setNodeState: normal / suspect / disabled; a disabled node stops verifying', () => {
    const minted = svc.mintNode({ operatorId: anna, name: 'a' }, T0);
    expect(svc.setNodeState(minted.record.id, 'suspect')?.state).toBe('suspect');
    expect(svc.verifyNodeToken(minted.token, T0)).toMatchObject({ kind: 'node' });
    expect(svc.setNodeState(minted.record.id, 'disabled')?.state).toBe('disabled');
    expect(svc.verifyNodeToken(minted.token, T0)).toEqual({ error: 'revoked' });
    expect(svc.setNodeState('zzzzzzzz', 'normal')).toBeUndefined();
    expect(() => svc.setNodeState(minted.record.id, 'bogus' as 'normal')).toThrow(HubInputError);
  });
});
