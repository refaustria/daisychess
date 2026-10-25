import { describe, expect, it, vi } from 'vitest';
import type { Limits } from '@daisychess/engine-core';
import { HubNodeLink } from './HubNodeLink.js';
import { NodeRegistry, type NodeRegistration } from './NodeRegistry.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const LIMITS: Limits = {
  maxDepth: 20,
  maxMultipv: 3,
  maxThreads: 2,
  maxHash: 64,
  maxMovetimeMs: 60_000,
  maxSessionsPerConnection: 2,
};
const linkFor = (nodeId: string) =>
  new HubNodeLink({ nodeId, send: () => true, logger: silent, onAbuse: () => {} });

const reg = (nodeId: string, over: Partial<NodeRegistration> = {}): NodeRegistration => ({
  nodeId,
  name: nodeId,
  operatorId: 'op',
  version: '0.1.0',
  platform: 'linux',
  arch: 'x64',
  engines: [{ id: 'sf', name: 'SF', enabled: true, defaults: { threads: 1, hash: 16 } }],
  limits: LIMITS,
  maxSessions: 4,
  pool: true,
  poolShare: 2,
  connectedAt: 1,
  link: linkFor(nodeId),
  ...over,
});

describe('NodeRegistry', () => {
  it('lists online nodes and filters pool candidates', () => {
    const r = new NodeRegistry();
    r.register(reg('a'));
    r.register(reg('b', { pool: false }));
    r.register(reg('c', { poolShare: 0 }));
    const d = r.register(reg('d'));
    r.setDraining('d', d.link, 'update');
    expect(r.online().map((n) => n.nodeId)).toEqual(['a', 'b', 'c', 'd']);
    expect(r.poolCandidates().map((n) => n.nodeId)).toEqual(['a']);
    expect(r.get('d')).toMatchObject({ state: 'draining', drainReason: 'update' });
    expect(r.get('zz')).toBeUndefined();
  });

  it('ignores updates and removal from a stale link of a replaced node', () => {
    const r = new NodeRegistry();
    const events: string[] = [];
    const firstReg = reg('a');
    r.onChange((e) => events.push(`${e.type}:${e.node.link === firstReg.link ? 1 : 2}`));
    const first = r.register(firstReg);
    const second = r.register(reg('a'));
    const status = {
      type: 'node.status' as const,
      sessions: 1,
      maxSessions: 9,
      load1: 0,
      engines: [],
    };
    r.updateStatus('a', first.link, status, 5);
    r.setDraining('a', first.link, 'shutdown');
    r.setRtt('a', first.link, 12);
    expect(r.unregister('a', first.link)).toBe(false);
    expect(r.get('a')).toBe(second);
    expect(second).toMatchObject({ state: 'online', status: null, rttMs: null, maxSessions: 4 });
    r.updateStatus('a', second.link, status, 5);
    r.setRtt('a', second.link, 12.4);
    expect(second).toMatchObject({ maxSessions: 9, status: { sessions: 1, at: 5 }, rttMs: 12 });
    expect(r.unregister('a', second.link)).toBe(true);
    expect(r.size).toBe(0);
    expect(events).toEqual(['online:1', 'online:2', 'status:2', 'offline:2']);
  });

  it('isolates a failing listener and supports unsubscribe', () => {
    const log = { ...silent, warn: vi.fn() };
    const r = new NodeRegistry(log);
    const good = vi.fn();
    r.onChange(() => {
      throw new Error('boom');
    });
    const off = r.onChange(good);
    r.register(reg('a'));
    expect(good).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    off();
    r.register(reg('b'));
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('NodeRegistry.applySettings (portal, M24-9)', () => {
  it('updates name, pool share and effective pool membership of a connected node', () => {
    const r = new NodeRegistry(silent);
    const events: string[] = [];
    r.onChange((e) => events.push(`${e.type}:${e.node.nodeId}`));
    r.register(reg('a', { nodePool: true }));
    expect(
      r.applySettings('a', { name: 'renamed', pool: true, poolShare: 3, state: 'normal' }),
    ).toBe(true);
    expect(r.get('a')).toMatchObject({ name: 'renamed', pool: true, poolShare: 3 });
    // Portal switch off, then suspect: out of the pool.
    r.applySettings('a', { name: 'renamed', pool: false, poolShare: 3, state: 'normal' });
    expect(r.poolCandidates()).toEqual([]);
    r.applySettings('a', { name: 'renamed', pool: true, poolShare: 3, state: 'suspect' });
    expect(r.get('a')?.pool).toBe(false);
    r.applySettings('a', { name: 'renamed', pool: true, poolShare: 3, state: 'normal' });
    expect(r.poolCandidates().map((n) => n.nodeId)).toEqual(['a']);
    expect(events).toContain('status:a');
    expect(
      r.applySettings('missing', { name: 'x', pool: true, poolShare: 1, state: 'normal' }),
    ).toBe(false);
  });

  it('never puts a node into the pool whose own switch is off', () => {
    const r = new NodeRegistry(silent);
    r.register(reg('b', { pool: false, nodePool: false }));
    r.applySettings('b', { name: 'b', pool: true, poolShare: 2, state: 'normal' });
    expect(r.get('b')?.pool).toBe(false);
    // Without nodePool, the registered `pool` is taken as the node's switch.
    r.register(reg('c', { pool: false }));
    r.applySettings('c', { name: 'c', pool: true, poolShare: 2, state: 'normal' });
    expect(r.get('c')?.pool).toBe(false);
  });
});
