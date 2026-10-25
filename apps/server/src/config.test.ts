import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '@daisychess/engine-core';
import { loadConfig } from './config.js';
import { DEFAULT_ROOM_CONFIG } from './rooms/RoomManager.js';

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
      rooms: DEFAULT_ROOM_CONFIG,
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
  it('parses the review store settings (ADR-017) with a 5 GB default cap', () => {
    const d = loadConfig({});
    expect(d.reviewStore).toMatchObject({
      enabled: true,
      maxBytes: 5_000_000_000,
      putPerIpPerDay: 500,
    });
    expect(path.isAbsolute(d.reviewStore.path)).toBe(true);
    expect(d.reviewStore.path.endsWith(path.join('apps', 'server', 'data', 'reviews.sqlite'))).toBe(true);
    const c = loadConfig({
      REVIEW_STORE: 'off',
      REVIEW_STORE_PATH: 'var/reviews.db',
      REVIEW_STORE_MAX_BYTES: '20000000000',
      REVIEW_PUT_PER_IP_PER_DAY: '50',
    });
    expect(c.reviewStore).toEqual({
      enabled: false,
      path: path.resolve('var/reviews.db'),
      maxBytes: 20_000_000_000,
      putPerIpPerDay: 50,
    });
    expect(() => loadConfig({ REVIEW_STORE: 'maybe' })).toThrow(/REVIEW_STORE/);
    expect(() => loadConfig({ REVIEW_STORE_MAX_BYTES: '1000' })).toThrow(/REVIEW_STORE_MAX_BYTES/);
    expect(() => loadConfig({ REVIEW_PUT_PER_IP_PER_DAY: '0' })).toThrow(/REVIEW_PUT_PER_IP_PER_DAY/);
  });

  it('parses ACCESS_TOKEN (ADR-010): unset or empty = public, max 256 characters', () => {
    expect(loadConfig({}).accessToken).toBeNull();
    expect(loadConfig({ ACCESS_TOKEN: '' }).accessToken).toBeNull();
    expect(loadConfig({ ACCESS_TOKEN: 'abc123' }).accessToken).toBe('abc123');
    expect(() => loadConfig({ ACCESS_TOKEN: 'x'.repeat(257) })).toThrow(/ACCESS_TOKEN/);
  });

  it('parses the room policy (ADR-013) and rejects values out of range', () => {
    expect(DEFAULT_ROOM_CONFIG).toEqual({
      maxRooms: 200,
      maxSpectators: 10,
      createRateLimit: { max: 10, windowMs: 600_000 },
      waitingTtlMs: 900_000,
      finishedTtlMs: 600_000,
      idleTtlMs: 7_200_000,
      claimGraceMs: 60_000,
    });
    expect(
      loadConfig({
        ROOM_MAX_ROOMS: '5',
        ROOM_MAX_SPECTATORS: '0',
        ROOM_CREATE_PER_IP: '3',
        ROOM_CREATE_WINDOW_MS: '1000',
        ROOM_WAITING_TTL_MS: '2000',
        ROOM_FINISHED_TTL_MS: '3000',
        ROOM_IDLE_TTL_MS: '4000',
        ROOM_CLAIM_GRACE_MS: '5000',
      }).rooms,
    ).toEqual({
      maxRooms: 5,
      maxSpectators: 0,
      createRateLimit: { max: 3, windowMs: 1000 },
      waitingTtlMs: 2000,
      finishedTtlMs: 3000,
      idleTtlMs: 4000,
      claimGraceMs: 5000,
    });
    expect(() => loadConfig({ ROOM_MAX_ROOMS: '0' })).toThrow(/ROOM_MAX_ROOMS/);
    expect(() => loadConfig({ ROOM_CLAIM_GRACE_MS: '10' })).toThrow(/ROOM_CLAIM_GRACE_MS/);
  });
});
