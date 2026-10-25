import { describe, expect, it } from 'vitest';
import { LINK_DEFAULTS } from '@daisychess/engine-core';
import { loadConfig } from './config.js';

describe('config: hub /link settings (M24-5)', () => {
  it('has defaults from LINK_DEFAULTS', () => {
    expect(loadConfig({}).link).toEqual({
      minNodeVersion: '0.0.0',
      latestNodeVersion: null,
      maxPerIp: 5,
      heartbeatMs: LINK_DEFAULTS.heartbeatMs,
      drainMs: LINK_DEFAULTS.drainMs,
      helloTimeoutMs: LINK_DEFAULTS.helloTimeoutMs,
      maxMessagesPerSecond: LINK_DEFAULTS.maxMessagesPerSecond,
    });
  });

  it('reads NODE_MIN_VERSION, NODE_LATEST_VERSION and LINK_*', () => {
    expect(
      loadConfig({
        ROLE: 'hub',
        NODE_MIN_VERSION: '0.4.0-rc.1',
        NODE_LATEST_VERSION: '0.5.2',
        LINK_MAX_PER_IP: '9',
        LINK_HEARTBEAT_MS: '5000',
        LINK_DRAIN_MS: '0',
        LINK_HELLO_TIMEOUT_MS: '2000',
        LINK_MAX_MSGS_PER_S: '100',
      }).link,
    ).toEqual({
      minNodeVersion: '0.4.0-rc.1',
      latestNodeVersion: '0.5.2',
      maxPerIp: 9,
      heartbeatMs: 5_000,
      drainMs: 0,
      helloTimeoutMs: 2_000,
      maxMessagesPerSecond: 100,
    });
  });

  it.each([
    ['NODE_MIN_VERSION', '1.2'],
    ['NODE_LATEST_VERSION', 'latest'],
    ['LINK_MAX_PER_IP', '0'],
    ['LINK_HEARTBEAT_MS', '500'],
    ['LINK_DRAIN_MS', '700000'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(name));
  });
});

describe('config: portal settings (M24-9)', () => {
  it('has defaults', () => {
    expect(loadConfig({}).portal).toEqual({
      publicOrigin: null,
      adminLichessIds: [],
      lichessProxy: 'http://127.0.0.1:8581/lichess/',
      lichessTimeoutMs: 5_000,
      maxNodes: 10,
      maxTokens: 100,
      poolTokensPerOperator: 20,
    });
  });

  it('reads PUBLIC_ORIGIN, HUB_ADMIN_LICHESS, PORTAL_* and POOL_TOKENS_PER_OPERATOR', () => {
    expect(
      loadConfig({
        PUBLIC_ORIGIN: 'https://C.Referee.at/',
        HUB_ADMIN_LICHESS: ' Bojan, other ,bojan,',
        PORTAL_LICHESS_PROXY: 'http://127.0.0.1:9999/egress?x=1',
        PORTAL_LICHESS_TIMEOUT_MS: '2000',
        PORTAL_MAX_NODES: '3',
        PORTAL_MAX_TOKENS: '7',
        POOL_TOKENS_PER_OPERATOR: '0',
      }).portal,
    ).toEqual({
      publicOrigin: 'https://c.referee.at',
      adminLichessIds: ['bojan', 'other'],
      lichessProxy: 'http://127.0.0.1:9999/egress/',
      lichessTimeoutMs: 2_000,
      maxNodes: 3,
      maxTokens: 7,
      poolTokensPerOperator: 0,
    });
  });

  it('rejects malformed values', () => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'c.referee.at' })).toThrow(/PUBLIC_ORIGIN/);
    expect(() => loadConfig({ PORTAL_LICHESS_PROXY: 'ftp://x/' })).toThrow(/PORTAL_LICHESS_PROXY/);
    expect(() => loadConfig({ PORTAL_LICHESS_PROXY: 'http://u:p@x/' })).toThrow(
      /PORTAL_LICHESS_PROXY/,
    );
    expect(() => loadConfig({ PORTAL_MAX_NODES: '0' })).toThrow(/PORTAL_MAX_NODES/);
  });
});
