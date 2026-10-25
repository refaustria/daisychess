import { describe, expect, it } from 'vitest';
import { checkHubUrl, loadConfig } from './config.js';

const TOKEN = `dcn_abcdefgh_${'a'.repeat(32)}`;
const NODE = { ROLE: 'node', HUB_URL: 'wss://hub.example/link', NODE_TOKEN: TOKEN };

describe('loadConfig: roles (ADR-020 §7)', () => {
  it('defaults to standalone without node settings', () => {
    const c = loadConfig({});
    expect(c.role).toBe('standalone');
    expect(c.node).toBeNull();
    expect(loadConfig({ ROLE: 'hub' }).role).toBe('hub');
    expect(() => loadConfig({ ROLE: 'relay' })).toThrow(/ROLE/);
  });

  it('ROLE=node parses the node keys; NODE_MAX_SESSIONS defaults to MAX_SESSIONS', () => {
    const c = loadConfig({ ...NODE, MAX_SESSIONS: '6' });
    expect(c.role).toBe('node');
    expect(c.node).toEqual({
      hubUrl: 'wss://hub.example/link',
      token: TOKEN,
      name: null,
      pool: false,
      maxSessions: 6,
    });
    expect(
      loadConfig({
        ...NODE,
        MAX_SESSIONS: '6',
        NODE_MAX_SESSIONS: '3',
        NODE_POOL: 'on',
        NODE_NAME: 'fast-box',
      }).node,
    ).toMatchObject({ maxSessions: 3, pool: true, name: 'fast-box' });
  });

  it('ROLE=node binds /health to loopback whatever HOST says', () => {
    expect(loadConfig({ ...NODE, HOST: '0.0.0.0' }).host).toBe('127.0.0.1');
    expect(loadConfig({ ...NODE, HOST: '::1' }).host).toBe('::1');
    expect(loadConfig({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0'); // standalone unchanged
  });

  it('ROLE=node requires HUB_URL and a dcn_ NODE_TOKEN (never echoed)', () => {
    expect(() => loadConfig({ ROLE: 'node', NODE_TOKEN: TOKEN })).toThrow(/HUB_URL/);
    expect(() => loadConfig({ ...NODE, NODE_TOKEN: undefined })).toThrow(/NODE_TOKEN/);
    const player = `dc1_abcdefgh_${'b'.repeat(32)}`;
    let message = '';
    try {
      loadConfig({ ...NODE, NODE_TOKEN: player });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/NODE_TOKEN/);
    expect(message).not.toContain(player);
    expect(() => loadConfig({ ...NODE, NODE_TOKEN: 'secret' })).toThrow(/dcn_/);
  });

  it('rejects NODE_MAX_SESSIONS above MAX_SESSIONS and invalid NODE_POOL', () => {
    expect(() => loadConfig({ ...NODE, MAX_SESSIONS: '2', NODE_MAX_SESSIONS: '3' })).toThrow(
      /NODE_MAX_SESSIONS/,
    );
    expect(() => loadConfig({ ...NODE, NODE_POOL: 'yes' })).toThrow(/NODE_POOL/);
  });

  it('node keys are ignored for other roles', () => {
    expect(loadConfig({ HUB_URL: 'not a url', NODE_TOKEN: 'x' }).node).toBeNull();
  });
});

describe('checkHubUrl', () => {
  it('accepts wss:// and loopback ws://', () => {
    expect(checkHubUrl('wss://c.referee.at/link', false)).toBeNull();
    expect(checkHubUrl('ws://127.0.0.1:8580/link', false)).toBeNull();
    expect(checkHubUrl('ws://localhost:8580/link', false)).toBeNull();
    expect(checkHubUrl('ws://[::1]:8580/link', false)).toBeNull();
  });
  it('refuses remote ws:// unless DAISYCHESS_INSECURE=1, other schemes and credentials', () => {
    expect(checkHubUrl('ws://hub.example/link', false)).toMatch(/wss/);
    expect(checkHubUrl('ws://hub.example/link', true)).toBeNull();
    expect(checkHubUrl('https://hub.example/link', true)).toMatch(/ws/);
    expect(checkHubUrl('wss://u:p@hub.example/link', false)).toMatch(/credentials/);
    expect(checkHubUrl('nonsense', false)).toMatch(/URL/);
    expect(() =>
      loadConfig({ ...NODE, HUB_URL: 'ws://hub.example/link', DAISYCHESS_INSECURE: '1' }),
    ).not.toThrow();
    expect(() => loadConfig({ ...NODE, HUB_URL: 'ws://hub.example/link' })).toThrow(/wss/);
  });
});
