import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '@chesslab/engine-core';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults (ADR-001 port, ADR-006 limits)', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      port: 8580,
      host: '127.0.0.1',
      maxSessions: 4,
      limits: DEFAULT_LIMITS,
      engineIdleMs: 300_000,
      sessionIdleMs: 600_000,
      logLevel: 'info',
    });
    expect(path.basename(c.enginesConfig)).toBe('engines.json');
    expect(path.isAbsolute(c.enginesConfig)).toBe(true);
  });

  it('parses overrides and treats empty values as unset', () => {
    const c = loadConfig({
      PORT: '9000',
      MAX_SESSIONS: '6',
      MAX_DEPTH: '25',
      MAX_MULTIPV: '3',
      MAX_THREADS: '',
      MAX_HASH_MB: '1024',
      MAX_MOVETIME_MS: '30000',
      MAX_SESSIONS_PER_CONNECTION: '4',
      ENGINE_IDLE_MS: '60000',
      ENGINES_CONFIG: 'x/engines.json',
      LOG_LEVEL: 'debug',
    });
    expect(c.port).toBe(9000);
    expect(c.maxSessions).toBe(6);
    expect(c.limits).toEqual({
      maxDepth: 25,
      maxMultipv: 3,
      maxThreads: DEFAULT_LIMITS.maxThreads,
      maxHash: 1024,
      maxMovetimeMs: 30_000,
      maxSessionsPerConnection: 4,
    });
    expect(c.engineIdleMs).toBe(60_000);
    expect(c.enginesConfig).toBe(path.resolve('x/engines.json'));
    expect(c.logLevel).toBe('debug');
  });

  it('rejects values outside the protocol bounds', () => {
    expect(() => loadConfig({ MAX_DEPTH: '100' })).toThrow(/MAX_DEPTH/);
    expect(() => loadConfig({ MAX_MULTIPV: '0' })).toThrow(/MAX_MULTIPV/);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('parses ALLOWED_ORIGINS (ADR-008): unset = same host, list, wildcard; rejects garbage', () => {
    expect(loadConfig({}).allowedOrigins).toBeNull();
    expect(loadConfig({ ALLOWED_ORIGINS: '' }).allowedOrigins).toBeNull();
    expect(loadConfig({ ALLOWED_ORIGINS: '*' }).allowedOrigins).toBe('*');
    expect(
      loadConfig({ ALLOWED_ORIGINS: 'https://c.referee.at, http://localhost:8080' }).allowedOrigins,
    ).toEqual(['https://c.referee.at', 'http://localhost:8080']);
    expect(() => loadConfig({ ALLOWED_ORIGINS: 'c.referee.at' })).toThrow(/ALLOWED_ORIGINS/);
  });

  it('per-IP cap (default 2, never above MAX_SESSIONS), crash backoff, trusted proxies', () => {
    const d = loadConfig({});
    expect(d).toMatchObject({
      maxSessionsPerIp: 2,
      engineCrashResetMs: 60_000,
      engineMaxConsecutiveCrashes: 10,
      trustedProxies: [],
    });
    expect(loadConfig({ MAX_SESSIONS: '1' }).maxSessionsPerIp).toBe(1);
    expect(loadConfig({ MAX_SESSIONS: '8', MAX_SESSIONS_PER_IP: '3' }).maxSessionsPerIp).toBe(3);
    expect(() => loadConfig({ MAX_SESSIONS: '4', MAX_SESSIONS_PER_IP: '5' })).toThrow(
      /MAX_SESSIONS_PER_IP/,
    );
    expect(() => loadConfig({ MAX_SESSIONS_PER_IP: '0' })).toThrow(/MAX_SESSIONS_PER_IP/);
    const c = loadConfig({
      ENGINE_CRASH_RESET_MS: '30000',
      ENGINE_MAX_CONSECUTIVE_CRASHES: '5',
      TRUSTED_PROXIES: '*',
    });
    expect(c).toMatchObject({
      engineCrashResetMs: 30_000,
      engineMaxConsecutiveCrashes: 5,
      trustedProxies: '*',
    });
    expect(() => loadConfig({ TRUSTED_PROXIES: 'nginx' })).toThrow(/TRUSTED_PROXIES/);
  });
  it('parses ACCESS_TOKEN (ADR-010): unset or empty = public, max 256 characters', () => {
    expect(loadConfig({}).accessToken).toBeNull();
    expect(loadConfig({ ACCESS_TOKEN: '' }).accessToken).toBeNull();
    expect(loadConfig({ ACCESS_TOKEN: 'abc123' }).accessToken).toBe('abc123');
    expect(() => loadConfig({ ACCESS_TOKEN: 'x'.repeat(257) })).toThrow(/ACCESS_TOKEN/);
  });
});
