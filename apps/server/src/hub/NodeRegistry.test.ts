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
