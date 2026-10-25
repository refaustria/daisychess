import { constants } from 'node:fs';
import { requestSerializer } from './logging/ipHash.js';
import { access, readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import type { EngineDescriptor, Limits } from '@daisychess/engine-core';
import { loadConfig, type ServerConfig } from './config.js';
import { EnginePool, type EnginePoolOptions, type SpawnEngine } from './engines/EnginePool.js';
import { loadEngineRegistry, type EngineConfig, type EngineRegistry } from './engines/registry.js';
import { attachWebSocketServer, type WsServerHandle, type WsServerOptions } from './ws/server.js';
import { ReviewStore } from './review/ReviewStore.js';
import { ClientSessions } from './sessions/ClientSessions.js';
import { LocalBackend } from './sessions/LocalBackend.js';
import { UnlimitedLedger } from './sessions/UnlimitedLedger.js';
import { NodeLink, type NodeLinkOptions } from './node/NodeLink.js';
import { HubStore } from './hub/store/HubStore.js';
import { HubTokenService } from './hub/tokens.js';
import { NodeRegistry } from './hub/NodeRegistry.js';
import { LinkServer, type LinkServerOptions } from './hub/LinkServer.js';
import { HubRouter, type HubRouterOptions, type LocalNode } from './hub/Router.js';
import type { BudgetSource, UsageSink } from './hub/AccountingChannel.js';
import { Reputation, SpotChecker, createPoolChecker } from './hub/SpotCheck.js';
import type { IpSessionLedger } from './ws/clientIp.js';
import { DEFAULT_BAD_TOKEN_LIMIT } from './ws/badTokens.js';
import { registerPortalRoutes, type PortalOptions } from './hub/portal/routes.js';
import { createLichessFetcher } from './hub/portal/lichess.js';

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
  /** Tests: destination of the JSON log lines instead of stdout (capture for PII checks). */
  logStream?: { write(line: string): void };
  /** Connection tuning (timeouts, rate limits) for tests. */
  connection?: Partial<
    Pick<
      WsServerOptions,
      | 'stopTimeoutMs'
      | 'handshakeTimeoutMs'
      | 'analyzeRateLimit'
      | 'messageRateLimit'
      | 'roomRateLimit'
      | 'reviewGetRateLimit'
      | 'reviewPutRateLimit'
      | 'maxBufferedBytes'
      | 'badTokenLimit'
    >
  >;
  /** Room manager tuning for tests (clock, id generators). */
  roomManager?: WsServerOptions['roomManager'];
  /** WebSocket heartbeat interval. */
  heartbeatMs?: number;
  /** Pool tuning for tests (respawn backoff timing, clock). */
  pool?: Pick<EnginePoolOptions, 'backoffBaseMs' | 'backoffMaxMs' | 'now' | 'random'>;
  /** `ROLE=node`: link tuning and injection for tests (socket factory, exit, timings). */
  node?: Partial<
    Pick<
      NodeLinkOptions,
      | 'connect'
      | 'exit'
      | 'random'
      | 'load1'
      | 'platform'
      | 'arch'
      | 'welcomeTimeoutMs'
      | 'maxDrainMs'
      | 'reconnectMinMs'
      | 'reconnectMaxMs'
      | 'stopTimeoutMs'
      | 'closeTimeoutMs'
    >
  >;
  /** `ROLE=hub`: router tuning for tests (clock, sticky and failure windows). */
  hubRouter?: Partial<Pick<HubRouterOptions, 'now' | 'stickyMs' | 'failurePenaltyMs'>>;
  /** `ROLE=hub`: spot-check injection for tests (sampling randomness, clock). */
  spotCheck?: { random?: () => number; now?: () => number };
  /** `ROLE=hub`: portal API injection for tests (lichess fetcher, clock, rate limits). */
  portal?: Partial<
    Pick<PortalOptions, 'fetchAccount' | 'now' | 'random' | 'loginRateLimit' | 'apiRateLimit'>
  >;
  /** `ROLE=hub`: `/link` tuning for tests (ping cadence, clocks, limits). */
  hub?: Partial<
    Pick<
      LinkServerOptions,
      | 'pingIntervalMs'
      | 'missedPongsToDrop'
      | 'closeTimeoutMs'
      | 'now'
      | 'relay'
      | 'invalidFrameLimit'
      | 'unknownCidLimit'
    >
  >;
}

/** `ROLE=hub` parts (ADR-020): the hub store, token service, online nodes and `/link`. */
export interface HubParts {
  store: HubStore;
  tokens: HubTokenService;
  registry: NodeRegistry;
  link: LinkServer;
  /** Set once `/ws` is attached. */
  router: HubRouter | null;
  /** Spot-check reputation of nodes (M24-12). */
  reputation: Reputation;
  /** Pool spot-checks (M24-12); set together with the router. */
  spotCheck: SpotChecker | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** `ROLE=standalone`/`hub`. Not decorated for `ROLE=node` (no WebSocket server there). */
    daisychess: { pool: EnginePool; ws: WsServerHandle; config: ServerConfig };
    /** `ROLE=node` only (ADR-020 §7): the pool and the outbound hub link. */
    daisychessNode: { pool: EnginePool; link: NodeLink; config: ServerConfig };
    /** `ROLE=hub` only: store, tokens, node registry and the `/link` server (M24-5). */
    daisychessHub: HubParts;
  }
}

/** UCI options a registry entry may set as defaults (others are ignored with a warning). */
const REGISTRY_OPTIONS = new Set(['Threads', 'Hash']);

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    logger:
      opts.logger === false || config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            // Request lines carry a daily-salted address hash, never `remoteAddress` or the query
            // string (M24-15, ADR-020 logging without PII).
            serializers: { req: requestSerializer(config.trustedProxies) },
            ...(opts.logStream ? { stream: opts.logStream } : {}),
          },
  });

  const loaded = opts.registry ?? (await loadEngineRegistry(config.enginesConfig));
  const registry: EngineRegistry = {
    engines: await checkEngines(app, loaded.engines, config, opts.spawnEngine === undefined),
  };
  const descriptors = registry.engines.map((e) => toDescriptor(e, config.limits));

  const pool = new EnginePool(registry, {
    ...opts.pool,
    // A node announces NODE_MAX_SESSIONS (≤ MAX_SESSIONS) and the pool enforces it.
    maxSessions: config.node?.maxSessions ?? config.maxSessions,
    idleMs: config.engineIdleMs,
    crashResetMs: config.engineCrashResetMs,
    maxConsecutiveCrashes: config.engineMaxConsecutiveCrashes,
    groupLimits: { [MAIA_GROUP]: config.maia.maxProcesses },
    ...(opts.spawnEngine ? { spawn: opts.spawnEngine } : {}),
    logger: app.log.child({ component: 'pool' }),
  });
  if (config.node) return buildNode(app, opts, config, config.node, pool, descriptors);
  const hub = config.role === 'hub' ? await buildHub(app, opts, config) : null;

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
    ...(hub
      ? {
          // ADR-020 §4.1: 20 bad tokens in 10 min per address → rate_limited and close.
          badTokenLimit: opts.connection?.badTokenLimit ?? DEFAULT_BAD_TOKEN_LIMIT,
          upgradeRoutes: { [hub.link.path]: hub.link.handleUpgrade.bind(hub.link) },
          router: ({ ledger }: { ledger: IpSessionLedger }) => {
            hub.router = createHubRouter(
              app,
              opts,
              config,
              hub,
              pool,
              registry,
              descriptors,
              ledger,
            );
            return hub.router;
          },
        }
      : {}),
  });
  app.decorate('daisychess', { pool, ws, config });
  if (hub) {
    app.decorate('daisychessHub', hub);
    // Operator portal API (M24-9); not registered for other roles (→ 404).
    await registerPortalRoutes(app, {
      store: hub.store,
      tokens: hub.tokens,
      registry: hub.registry,
      links: hub.link,
      connections: ws,
      settings: config.portal,
      allowedOrigins: config.allowedOrigins,
      trustedProxies: config.trustedProxies,
      fetchAccount:
        opts.portal?.fetchAccount ??
        createLichessFetcher({
          baseUrl: config.portal.lichessProxy,
          timeoutMs: config.portal.lichessTimeoutMs,
        }),
      logger: app.log.child({ component: 'portal' }),
      ...(opts.portal?.now ? { now: opts.portal.now } : {}),
      ...(opts.portal?.random ? { random: opts.portal.random } : {}),
      ...(opts.portal?.loginRateLimit ? { loginRateLimit: opts.portal.loginRateLimit } : {}),
      ...(opts.portal?.apiRateLimit ? { apiRateLimit: opts.portal.apiRateLimit } : {}),
    });
  }

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
    ...(hub
      ? {
          role: 'hub',
          nodes: hub.link.stats(),
          router: hub.router?.stats() ?? null,
          spotchecks: hub.spotCheck?.stats() ?? null,
        }
      : {}),
  }));

  // Hub retention: usage aggregates, portal sessions, spot-checks (ADR-020 §6), daily.
  let purgeTimer: ReturnType<typeof setInterval> | null = null;
  let cooldownTimer: ReturnType<typeof setInterval> | null = null;
  if (hub) {
    const purge = () => {
      try {
        const purged = hub.tokens.purge();
        app.log.info({ component: 'hub', purged }, 'hub store purged');
      } catch (err) {
        app.log.warn({ component: 'hub', err: (err as Error).message }, 'hub store purge failed');
      }
    };
    app.addHook('onReady', async () => {
      purge();
      purgeTimer = setInterval(purge, 24 * 3_600_000);
      purgeTimer.unref();
      // Suspect nodes whose cool-down ended go back to the pool (M24-12).
      const sweep = () => {
        try {
          hub.reputation.expireCooldowns(Date.now());
        } catch (err) {
          app.log.warn(
            { component: 'spotcheck', err: (err as Error).message },
            'spot-check cool-down sweep failed',
          );
        }
      };
      sweep();
      cooldownTimer = setInterval(sweep, 5 * 60_000);
      cooldownTimer.unref();
    });
  }

  // Close WebSockets (players first, then node links) before the HTTP server stops, then kill
  // every engine process.
  app.addHook('preClose', async () => {
    if (purgeTimer) clearInterval(purgeTimer);
    if (cooldownTimer) clearInterval(cooldownTimer);
    await hub?.spotCheck?.close();
    await ws.close();
    await hub?.link.close();
    hub?.router?.dispose();
  });
  app.addHook('onClose', async () => {
    await pool.shutdown();
    hub?.store.close();
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

/**
 * `ROLE=node` (ADR-020 §7): the pool plus the outbound link; no `/ws`, no rooms, no review store
 * (those live on the hub). `/health` and `/health/detail` (with the link state) are served on
 * the loopback listener only (`loadConfig` forces a loopback HOST for this role). The link
 * starts when the app is ready and closes before the pool shuts down.
 */
function buildNode(
  app: FastifyInstance,
  opts: BuildAppOptions,
  config: ServerConfig,
  node: NonNullable<ServerConfig['node']>,
  pool: EnginePool,
  descriptors: EngineDescriptor[],
): FastifyInstance {
  const tuning = opts.node ?? {};
  const exit =
    tuning.exit ??
    (async (code: number) => {
      // Fatal link end: stop the engines cleanly, then exit non-zero (no restart storm).
      await app.close().catch(() => {});
      process.exit(code);
    });
  const link = new NodeLink({
    ...tuning,
    exit,
    hubUrl: node.hubUrl,
    token: node.token,
    version: SERVER_VERSION,
    localName: node.name,
    engines: descriptors,
    limits: config.limits,
    maxSessions: node.maxSessions,
    pool: node.pool,
    backend: new LocalBackend(pool),
    engineStatus: () =>
      pool.stats().map((e) => ({ id: e.id, busy: e.busy, idle: e.idle, degraded: e.degraded })),
    logger: app.log.child({ component: 'link' }),
    sessionIdleMs: config.sessionIdleMs,
  });
  app.decorate('daisychessNode', { pool, link, config });

  app.get('/health', async () => ({ status: 'ok', version: SERVER_VERSION }));
  app.get('/health/detail', async () => ({
    status: 'ok',
    version: SERVER_VERSION,
    role: 'node',
    engines: pool.stats(),
    processGroups: pool.groupStats(),
    sessions: pool.sessions,
    link: link.stats(),
  }));

  app.addHook('onReady', async () => {
    link.start();
  });
  app.addHook('preClose', async () => {
    await link.close();
  });
  app.addHook('onClose', async () => {
    await pool.shutdown();
  });

  app.log.info(
    {
      role: 'node',
      hub: link.stats().hubUrl,
      name: node.name,
      pool: node.pool,
      maxSessions: node.maxSessions,
      engines: descriptors.map((d) => ({ id: d.id, enabled: d.enabled })),
      limits: config.limits,
      maia: config.maia,
    },
    'engine node configured',
  );
  return app;
}

/**
 * `ROLE=hub` (ADR-020 §6, §3): opens the hub store (required: a hub without it cannot verify
 * node tokens, so a failure aborts the start), the token service and the `/link` server. Player
 * routing over the registry is M24-6.
 */
async function buildHub(
  app: FastifyInstance,
  opts: BuildAppOptions,
  config: ServerConfig,
): Promise<HubParts> {
  const log = app.log.child({ component: 'hub' });
  const store = await HubStore.open({ path: config.hub.storePath }, log);
  let tokens: HubTokenService;
  try {
    tokens = new HubTokenService(store, {
      accessToken: config.accessToken,
      poolDailyBudgetMin: config.hub.poolDailyBudgetMin,
      usageRetentionDays: config.hub.usageRetentionDays,
    });
  } catch (err) {
    store.close();
    throw err;
  }
  const registry = new NodeRegistry(log);
  const link = new LinkServer({
    ...opts.hub,
    auth: tokens,
    seen: store,
    registry,
    logger: app.log.child({ component: 'link' }),
    hubVersion: SERVER_VERSION,
    minNodeVersion: config.link.minNodeVersion,
    latestNodeVersion: config.link.latestNodeVersion ?? SERVER_VERSION,
    heartbeatMs: config.link.heartbeatMs,
    drainMs: config.link.drainMs,
    helloTimeoutMs: config.link.helloTimeoutMs,
    maxPerIp: config.link.maxPerIp,
    maxMessagesPerSecond: config.link.maxMessagesPerSecond,
    trustedProxies: config.trustedProxies,
  });
  const spot = config.spotCheck;
  const reputation = new Reputation(
    store,
    {
      apply: (node) => registry.applySettings(node.id, node),
      evictShared: (node) => {
        const n = link.evictShared(node.id, 'engine node removed from the pool');
        if (n > 0) log.info({ nodeId: node.id, evicted: n }, 'spot-check: pool players moved off');
      },
    },
    app.log.child({ component: 'spotcheck' }),
    {
      window: spot.window,
      minChecks: spot.minChecks,
      maxDisagreeRate: spot.maxDisagreeRate,
      cooldownMs: spot.cooldownMs,
      maxEpisodes: spot.maxEpisodes,
    },
  );
  return { store, tokens, registry, link, router: null, reputation, spotCheck: null };
}

/**
 * The hub's router (ADR-020 §4, M24-6) over the node registry and the built-in node `local`
 * (this process's pool as `ClientSessions` with an unlimited ledger; the router's
 * `AccountingChannel` counts per IP — in the server's `IpSessionLedger` — and per token).
 * Usage goes to the hub store; the daily pool budget is read from it.
 */
function createHubRouter(
  app: FastifyInstance,
  opts: BuildAppOptions,
  config: ServerConfig,
  hub: HubParts,
  pool: EnginePool,
  engines: EngineRegistry,
  descriptors: EngineDescriptor[],
  ledger: IpSessionLedger,
): HubRouter {
  const logger = app.log.child({ component: 'router' });
  const backend = new LocalBackend(pool);
  const unlimited = new UnlimitedLedger();
  const tuning = opts.connection ?? {};
  const local: LocalNode = {
    name: config.hubRouter.localName,
    engines: descriptors,
    limits: config.limits,
    poolShare: config.hubRouter.localPoolShare,
    available: () => !pool.isClosed,
    hasFreeSlot: () => !pool.isClosed && pool.sessions < config.maxSessions,
    open: (deliver, peer, limits) =>
      new ClientSessions(deliver, peer, {
        backend,
        limits,
        engines: descriptors,
        logger: app.log.child({ component: 'ws' }),
        ledger: unlimited,
        sessionIdleMs: config.sessionIdleMs,
        ...(tuning.stopTimeoutMs !== undefined ? { stopTimeoutMs: tuning.stopTimeoutMs } : {}),
        ...(tuning.analyzeRateLimit ? { analyzeRateLimit: tuning.analyzeRateLimit } : {}),
      }),
  };
  const usage: UsageSink = {
    search: (u) => hub.tokens.addEngineTime(u.tokenId, u.engineMs, { nodeId: u.nodeId, now: u.at }),
    session: (u) => hub.tokens.recordSession(u.tokenId, u.nodeId, u.at),
  };
  const budget: BudgetSource = {
    remainingMs: (tokenId, now) => hub.tokens.remainingPoolBudgetMs(tokenId, now),
  };
  let router: HubRouter | null = null;
  const spot = config.spotCheck;
  const spotCheck = new SpotChecker({
    config: {
      rate: spot.rate,
      maxPerHour: spot.maxPerHour,
      toleranceCp: spot.toleranceCp,
      scoreToleranceCp: spot.scoreToleranceCp,
      minDepth: spot.minDepth,
      maxDepth: spot.maxDepth,
      movetimeMs: spot.movetimeMs,
    },
    local: createPoolChecker(pool, {
      maxSessions: config.maxSessions,
      maxInstances: (id) => engines.engines.find((e) => e.id === id)?.maxInstances ?? 0,
      playerSearches: () => router?.localSearches ?? 0,
      logger: app.log.child({ component: 'spotcheck' }),
    }),
    localEngines: descriptors,
    reputation: hub.reputation,
    logger: app.log.child({ component: 'spotcheck' }),
    ...(opts.spotCheck?.random ? { random: opts.spotCheck.random } : {}),
    ...(opts.spotCheck?.now ? { now: opts.spotCheck.now } : {}),
  });
  hub.spotCheck = spotCheck;
  router = new HubRouter({
    ...opts.hubRouter,
    spotCheck,
    tokens: hub.tokens,
    registry: hub.registry,
    local,
    operatorName: (id) => hub.store.getOperator(id)?.username,
    ipLedger: ledger,
    usage,
    budget,
    sessionIdleMs: config.sessionIdleMs,
    restrictedLimits: config.limits,
    ...(tuning.analyzeRateLimit ? { analyzeRateLimit: tuning.analyzeRateLimit } : {}),
    logger,
  });
  return router;
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
