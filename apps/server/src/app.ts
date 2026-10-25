import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import type { EngineDescriptor, Limits } from '@daisychess/engine-core';
import { loadConfig, type ServerConfig } from './config.js';
import { EnginePool, type EnginePoolOptions, type SpawnEngine } from './engines/EnginePool.js';
import { loadEngineRegistry, type EngineConfig, type EngineRegistry } from './engines/registry.js';
import { attachWebSocketServer, type WsServerHandle, type WsServerOptions } from './ws/server.js';
import type { ConnectionOptions } from './ws/connection.js';
import { ReviewStore } from './review/ReviewStore.js';

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
      | 'roomRateLimit'
      | 'reviewGetRateLimit'
      | 'reviewPutRateLimit'
      | 'maxBufferedBytes'
    >
  >;
  /** Room manager tuning for tests (clock, id generators). */
  roomManager?: WsServerOptions['roomManager'];
  /** WebSocket heartbeat interval. */
  heartbeatMs?: number;
  /** Pool tuning for tests (respawn backoff timing, clock). */
  pool?: Pick<EnginePoolOptions, 'backoffBaseMs' | 'backoffMaxMs' | 'now' | 'random'>;
}

declare module 'fastify' {
  interface FastifyInstance {
    daisychess: { pool: EnginePool; ws: WsServerHandle; config: ServerConfig };
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
  const registry: EngineRegistry = {
    engines: await checkEngines(app, loaded.engines, config, opts.spawnEngine === undefined),
  };
  const descriptors = registry.engines.map((e) => toDescriptor(e, config.limits));

  const pool = new EnginePool(registry, {
    ...opts.pool,
    maxSessions: config.maxSessions,
    idleMs: config.engineIdleMs,
    crashResetMs: config.engineCrashResetMs,
    maxConsecutiveCrashes: config.engineMaxConsecutiveCrashes,
    groupLimits: { [MAIA_GROUP]: config.maia.maxProcesses },
    ...(opts.spawnEngine ? { spawn: opts.spawnEngine } : {}),
    logger: app.log.child({ component: 'pool' }),
  });
  const reviewStore = await openReviewStore(app, config);
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
    accessToken: config.accessToken,
    roomConfig: config.rooms,
    reviewStore,
    reviewPutPerIpPerDay: config.reviewStore.putPerIpPerDay,
    ...(opts.roomManager ? { roomManager: opts.roomManager } : {}),
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
  });
  app.decorate('daisychess', { pool, ws, config });

  // Public liveness probe (nginx proxies exactly `/health`): no capacity details, which would
  // tell anyone whether other people are analysing right now (docs/SECURITY.md).
  app.get('/health', async () => ({ status: 'ok', version: SERVER_VERSION }));
  // Operator view; only reachable on the loopback listener (not proxied).
  app.get('/health/detail', async () => ({
    status: 'ok',
    version: SERVER_VERSION,
    engines: pool.stats(),
    processGroups: pool.groupStats(),
    sessions: pool.sessions,
    connections: ws.connections.size,
    clientAddresses: ws.ipSessions.addresses,
    rooms: ws.rooms.stats(),
    reviewStore: ws.review.stats(),
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
      accessToken: config.accessToken !== null,
      rooms: config.rooms,
      reviewStore: { ...config.reviewStore, open: reviewStore !== null },
      maia: config.maia,
    },
    'engine server configured',
  );
  return app;
}

/** Opens the review store (ADR-017) unless disabled; a failure only disables the feature. */
async function openReviewStore(
  app: FastifyInstance,
  config: ServerConfig,
): Promise<ReviewStore | null> {
  const settings = config.reviewStore;
  if (!settings.enabled) return null;
  try {
    return await ReviewStore.open(
      { path: settings.path, maxBytes: settings.maxBytes },
      app.log.child({ component: 'review-store' }),
    );
  } catch (err) {
    app.log.warn(
      { path: settings.path, err: (err as Error).message },
      'review store unavailable; continuing without it (capabilities.reviewStore: false)',
    );
    return null;
  }
}

/** Registry group of the Lc0 + Maia engines (ADR-019): `MAIA=off` and `MAIA_MAX_PROCESSES` apply to it. */
export const MAIA_GROUP = 'maia';

/**
 * Disables enabled engines whose binary is not executable or whose weights file is not readable
 * (one warning per missing file, not per engine: the nine Maia levels share one binary), and
 * every engine of group `maia` when `MAIA=off`.
 */
async function checkEngines(
  app: FastifyInstance,
  engines: readonly EngineConfig[],
  config: ServerConfig,
  checkFiles: boolean,
): Promise<EngineConfig[]> {
  const missing = new Map<string, string[]>(); // file → engine ids
  const out: EngineConfig[] = [];
  for (const engine of engines) {
    for (const name of Object.keys(engine.options)) {
      if (!REGISTRY_OPTIONS.has(name)) {
        app.log.warn({ engine: engine.id, option: name }, 'ignoring unsupported registry option');
      }
    }
    if (!engine.enabled) {
      out.push(engine);
      continue;
    }
    if (engine.group === MAIA_GROUP && !config.maia.enabled) {
      out.push({ ...engine, enabled: false });
      continue;
    }
    if (!checkFiles) {
      out.push(engine);
      continue;
    }
    const files: [path: string, mode: number][] = [[engine.binary, constants.X_OK]];
    if (engine.weights) files.push([engine.weights, constants.R_OK]);
    let ok = true;
    for (const [file, mode] of files) {
      const present = await access(file, mode).then(
        () => true,
        () => false,
      );
      if (!present) {
        ok = false;
        missing.set(file, [...(missing.get(file) ?? []), engine.id]);
      }
    }
    out.push(ok ? engine : { ...engine, enabled: false });
  }
  for (const [file, ids] of missing) {
    app.log.warn(
      { file, engines: ids },
      'engine file missing or not accessible; disabling (run `pnpm fetch-engines`, for Lc0 `pnpm build-lc0`)',
    );
  }
  if (!config.maia.enabled && engines.some((e) => e.group === MAIA_GROUP && e.enabled)) {
    app.log.info('MAIA=off: human-like engines disabled');
  }
  return out;
}

function toDescriptor(engine: EngineConfig, limits: Limits): EngineDescriptor {
  const opt = (name: string, fallback: number) => {
    const v = engine.options[name];
    return typeof v === 'number' && Number.isInteger(v) ? v : fallback;
  };
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 1), max);
  const descriptor: EngineDescriptor = {
    id: engine.id,
    name: engine.name.slice(0, 64),
    enabled: engine.enabled,
    defaults: {
      threads: clamp(opt('Threads', 1), limits.maxThreads),
      hash: clamp(opt('Hash', 16), limits.maxHash),
    },
  };
  // Additive ADR-019 fields: only present when they say something (strength engines stay as before).
  if (engine.style !== 'strength') descriptor.style = engine.style;
  if (engine.rating !== undefined) descriptor.rating = engine.rating;
  if (engine.maxNodes !== undefined) {
    descriptor.maxNodes = Math.min(engine.maxNodes, limits.maxNodes ?? engine.maxNodes);
  }
  return descriptor;
}
