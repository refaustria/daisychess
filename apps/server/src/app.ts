import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import type { EngineDescriptor, Limits } from '@chesslab/engine-core';
import { loadConfig, type ServerConfig } from './config.js';
import { EnginePool, type EnginePoolOptions, type SpawnEngine } from './engines/EnginePool.js';
import { loadEngineRegistry, type EngineConfig, type EngineRegistry } from './engines/registry.js';
import { attachWebSocketServer, type WsServerHandle } from './ws/server.js';
import type { ConnectionOptions } from './ws/connection.js';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const SERVER_VERSION = pkg.version;

export interface BuildAppOptions {
  /** Defaults to {@link loadConfig}(process.env). */
  config?: ServerConfig;
  /** Defaults to loading `config.enginesConfig`. */
  registry?: EngineRegistry;
  /** Process factory (tests use the fake engine). Default: spawn `binary` directly. */
  spawnEngine?: SpawnEngine;
  /** false disables logging regardless of `config.logLevel`. */
  logger?: boolean;
  /** Connection tuning (timeouts, rate limits) for tests. */
  connection?: Partial<
    Pick<
      ConnectionOptions,
      | 'stopTimeoutMs'
      | 'handshakeTimeoutMs'
      | 'analyzeRateLimit'
      | 'messageRateLimit'
      | 'maxBufferedBytes'
    >
  >;
  /** WebSocket heartbeat interval. */
  heartbeatMs?: number;
  /** Pool tuning for tests (respawn backoff timing, clock). */
  pool?: Pick<EnginePoolOptions, 'backoffBaseMs' | 'backoffMaxMs' | 'now' | 'random'>;
}

declare module 'fastify' {
  interface FastifyInstance {
    chesslab: { pool: EnginePool; ws: WsServerHandle; config: ServerConfig };
  }
}

/** UCI options a registry entry may set as defaults (others are ignored with a warning). */
const REGISTRY_OPTIONS = new Set(['Threads', 'Hash']);

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    logger:
      opts.logger === false || config.logLevel === 'silent' ? false : { level: config.logLevel },
  });

  const loaded = opts.registry ?? (await loadEngineRegistry(config.enginesConfig));
  const registry: EngineRegistry = { engines: [] };
  for (const engine of loaded.engines) {
    registry.engines.push(await checkEngine(app, engine, opts.spawnEngine === undefined));
  }
  const descriptors = registry.engines.map((e) => toDescriptor(e, config.limits));

  const pool = new EnginePool(registry, {
    ...opts.pool,
    maxSessions: config.maxSessions,
    idleMs: config.engineIdleMs,
    crashResetMs: config.engineCrashResetMs,
    maxConsecutiveCrashes: config.engineMaxConsecutiveCrashes,
    ...(opts.spawnEngine ? { spawn: opts.spawnEngine } : {}),
    logger: app.log.child({ component: 'pool' }),
  });
  const ws = attachWebSocketServer(app, {
    ...opts.connection,
    pool,
    limits: config.limits,
    engines: descriptors,
    serverVersion: SERVER_VERSION,
    logger: app.log.child({ component: 'ws' }),
    sessionIdleMs: config.sessionIdleMs,
    allowedOrigins: config.allowedOrigins,
    maxSessionsPerIp: config.maxSessionsPerIp,
    trustedProxies: config.trustedProxies,
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
  });
  app.decorate('chesslab', { pool, ws, config });

  // Public liveness probe (nginx proxies exactly `/health`): no capacity details, which would
  // tell anyone whether other people are analysing right now (docs/SECURITY.md).
  app.get('/health', async () => ({ status: 'ok', version: SERVER_VERSION }));
  // Operator view; only reachable on the loopback listener (not proxied).
  app.get('/health/detail', async () => ({
    status: 'ok',
    version: SERVER_VERSION,
    engines: pool.stats(),
    sessions: pool.sessions,
    connections: ws.connections.size,
    clientAddresses: ws.ipSessions.addresses,
  }));

  // Close WebSockets before the HTTP server stops, then kill every engine process.
  app.addHook('preClose', async () => {
    await ws.close();
  });
  app.addHook('onClose', async () => {
    await pool.shutdown();
  });

  app.log.info(
    {
      engines: descriptors.map((d) => ({ id: d.id, enabled: d.enabled })),
      limits: config.limits,
      maxSessions: config.maxSessions,
      maxSessionsPerIp: config.maxSessionsPerIp,
    },
    'engine server configured',
  );
  return app;
}

/** Disables (with a warning) enabled engines whose binary is missing or not executable. */
async function checkEngine(
  app: FastifyInstance,
  engine: EngineConfig,
  checkBinary: boolean,
): Promise<EngineConfig> {
  for (const name of Object.keys(engine.options)) {
    if (!REGISTRY_OPTIONS.has(name)) {
      app.log.warn({ engine: engine.id, option: name }, 'ignoring unsupported registry option');
    }
  }
  if (!engine.enabled || !checkBinary) return engine;
  try {
    await access(engine.binary, constants.X_OK);
    return engine;
  } catch {
    app.log.warn(
      { engine: engine.id, binary: engine.binary },
      'engine binary missing or not executable; disabling (run `pnpm fetch-engines`)',
    );
    return { ...engine, enabled: false };
  }
}

function toDescriptor(engine: EngineConfig, limits: Limits): EngineDescriptor {
  const opt = (name: string, fallback: number) => {
    const v = engine.options[name];
    return typeof v === 'number' && Number.isInteger(v) ? v : fallback;
  };
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 1), max);
  return {
    id: engine.id,
    name: engine.name.slice(0, 64),
    enabled: engine.enabled,
    defaults: {
      threads: clamp(opt('Threads', 1), limits.maxThreads),
      hash: clamp(opt('Hash', 16), limits.maxHash),
    },
  };
}
