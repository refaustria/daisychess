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
});
