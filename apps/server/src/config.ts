import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  DEFAULT_LIMITS,
  LINK_BOUNDS,
  LINK_DEFAULTS,
  MAX_TOKEN_LENGTH,
  PROTOCOL_BOUNDS,
  parseToken,
  type Limits,
} from '@daisychess/engine-core';
import { normalizeOrigin, parseAllowedOrigins, type OriginPolicy } from './ws/origin.js';
import { parseTrustedProxies, type TrustedProxies } from './ws/clientIp.js';
import { DEFAULT_ROOM_CONFIG, type RoomConfig } from './rooms/RoomManager.js';

/** apps/server (one level above src/ or dist/). */
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const int = (min: number, max: number, def: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

/** Default `PORTAL_LICHESS_PROXY`: the nginx loopback egress proxy (ADR-020 §2). */
export const DEFAULT_LICHESS_PROXY = 'http://127.0.0.1:8581/lichess/';

/** Environment variables (all optional). Unknown variables are ignored. */
export const EnvSchema = z.object({
  PORT: int(0, 65_535, 8580),
  HOST: z.string().min(1).default('127.0.0.1'),
  /** Global cap on concurrently leased engine instances (all connections, all engines). */
  MAX_SESSIONS: int(1, 256, 4),
  /** Cap on concurrently leased engine sessions per client address (≤ MAX_SESSIONS). */
  MAX_SESSIONS_PER_IP: z.coerce.number().int().min(1).max(256).optional(),
  MAX_DEPTH: int(PROTOCOL_BOUNDS.depth.min, PROTOCOL_BOUNDS.depth.max, DEFAULT_LIMITS.maxDepth),
  MAX_MULTIPV: int(
    PROTOCOL_BOUNDS.multipv.min,
    PROTOCOL_BOUNDS.multipv.max,
    DEFAULT_LIMITS.maxMultipv,
  ),
  MAX_THREADS: int(
    PROTOCOL_BOUNDS.threads.min,
    PROTOCOL_BOUNDS.threads.max,
    DEFAULT_LIMITS.maxThreads,
  ),
  MAX_HASH_MB: int(PROTOCOL_BOUNDS.hashMb.min, PROTOCOL_BOUNDS.hashMb.max, DEFAULT_LIMITS.maxHash),
  MAX_MOVETIME_MS: int(
    PROTOCOL_BOUNDS.movetimeMs.min,
    PROTOCOL_BOUNDS.movetimeMs.max,
    DEFAULT_LIMITS.maxMovetimeMs,
  ),
  MAX_SESSIONS_PER_CONNECTION: int(
    PROTOCOL_BOUNDS.sessionsPerConnection.min,
    PROTOCOL_BOUNDS.sessionsPerConnection.max,
    DEFAULT_LIMITS.maxSessionsPerConnection,
  ),
  /** Cap on `analyze.nodes` (ADR-019), announced as `limits.maxNodes`. */
  MAX_NODES: int(
    PROTOCOL_BOUNDS.nodes.min,
    PROTOCOL_BOUNDS.nodes.max,
    DEFAULT_LIMITS.maxNodes ?? PROTOCOL_BOUNDS.nodes.max,
  ),
  // Maia / Lc0 (ADR-019).
  /** `off` disables every engine of group `maia` regardless of the registry. */
  MAIA: z.enum(['on', 'off']).default('on'),
  /** Total Lc0 processes of group `maia` (all nine levels together). */
  MAIA_MAX_PROCESSES: int(1, 64, 3),
  /** Idle engine processes beyond one per engine are killed after this many ms. */
  ENGINE_IDLE_MS: int(1_000, 86_400_000, 300_000),
  /** A session without a running search releases its engine after this many ms. */
  SESSION_IDLE_MS: int(1_000, 86_400_000, 600_000),
  /** An engine instance alive this long resets its engine's consecutive-crash counter. */
  ENGINE_CRASH_RESET_MS: int(1_000, 86_400_000, 60_000),
  /** Consecutive crashes after which an engine is reported `degraded` (backoff stays at max). */
  ENGINE_MAX_CONSECUTIVE_CRASHES: int(1, 1_000, 10),
  /** Path to engines.json; relative paths resolve against the working directory. */
  ENGINES_CONFIG: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Browser origins allowed to open `/ws` (ADR-008): comma-separated `scheme://host[:port]`
   * list, or `*` to disable the check. Unset: the origin must match the request's `Host`.
   */
  ALLOWED_ORIGINS: z
    .string()
    .transform((value, ctx) => {
      try {
        return parseAllowedOrigins(value);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
        return z.NEVER;
      }
    })
    .optional(),
  /**
   * Peers (besides loopback) whose `X-Real-IP` header is trusted for the per-IP cap:
   * comma-separated IP addresses, or `*` (only when the server port is not reachable directly).
   */
  TRUSTED_PROXIES: z
    .string()
    .transform((value, ctx) => {
      try {
        return parseTrustedProxies(value);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
        return z.NEVER;
      }
    })
    .optional(),
  /**
   * Shared access token (ADR-010): when set, `hello.token` must match or the handshake fails
   * with `unauthorized`. Unset or empty: the server is public.
   */
  ACCESS_TOKEN: z
    .string()
    .max(MAX_TOKEN_LENGTH, `must be at most ${MAX_TOKEN_LENGTH} characters`)
    .optional(),
  // Rooms (ADR-013).
  /** Live rooms of any status at once. */
  ROOM_MAX_ROOMS: int(1, 100_000, DEFAULT_ROOM_CONFIG.maxRooms),
  /** Spectators per room (0 disables spectating). */
  ROOM_MAX_SPECTATORS: int(0, 1_000, DEFAULT_ROOM_CONFIG.maxSpectators),
  /** `room.create` per client address within ROOM_CREATE_WINDOW_MS. */
  ROOM_CREATE_PER_IP: int(1, 100_000, DEFAULT_ROOM_CONFIG.createRateLimit.max),
  ROOM_CREATE_WINDOW_MS: int(1_000, 86_400_000, DEFAULT_ROOM_CONFIG.createRateLimit.windowMs),
  /** A room nobody joined is abandoned after this many ms. */
  ROOM_WAITING_TTL_MS: int(1_000, 86_400_000, DEFAULT_ROOM_CONFIG.waitingTtlMs),
  /** A finished room is deleted this many ms after its game ended. */
  ROOM_FINISHED_TTL_MS: int(1_000, 86_400_000, DEFAULT_ROOM_CONFIG.finishedTtlMs),
  /** A running game without a move for this many ms is abandoned. */
  ROOM_IDLE_TTL_MS: int(1_000, 604_800_000, DEFAULT_ROOM_CONFIG.idleTtlMs),
  /** A player must be disconnected this many ms before the opponent may claim. */
  ROOM_CLAIM_GRACE_MS: int(1_000, 3_600_000, DEFAULT_ROOM_CONFIG.claimGraceMs),
  // Review store (ADR-017).
  /** `off` disables the server-side review store (`capabilities.reviewStore: false`). */
  REVIEW_STORE: z.enum(['on', 'off']).default('on'),
  /** SQLite file; relative paths resolve against the working directory. Default apps/server/data/reviews.sqlite */
  REVIEW_STORE_PATH: z.string().min(1).optional(),
  /** Payload cap of the store in bytes; least recently used rows are evicted above it. */
  REVIEW_STORE_MAX_BYTES: int(1_000_000, 10_000_000_000_000, 5_000_000_000),
  /** `review.put` + `review.positions.put` per client address per UTC day. */
  REVIEW_PUT_PER_IP_PER_DAY: int(1, 1_000_000, 500),
  // Roles and the node side of the node ⇄ hub link (ADR-020 §3, §7; M24-3).
  /** `standalone` (default, today's server), `hub` (M24-6) or `node` (outbound link, no `/ws`). */
  ROLE: z.enum(['standalone', 'hub', 'node']).default('standalone'),
  /** `ROLE=node`: the hub's link endpoint, `wss://host/link` (plain `ws://` see {@link checkHubUrl}). */
  HUB_URL: z.string().min(1).max(2_048).optional(),
  /** `ROLE=node`: this node's `dcn_…` token from the portal. Never logged. */
  NODE_TOKEN: z.string().max(MAX_TOKEN_LENGTH).optional(),
  /** `ROLE=node`: local name for logs and `/health/detail` (the hub's name comes from the portal). */
  NODE_NAME: z.string().min(1).max(LINK_BOUNDS.nodeNameMaxLength).optional(),
  /** `ROLE=node`: offer this node to the shared pool (`node.hello.pool`; the portal decides too). */
  NODE_POOL: z.enum(['on', 'off']).default('off'),
  /** `ROLE=node`: node-wide session cap announced to the hub (≤ MAX_SESSIONS; default MAX_SESSIONS). */
  NODE_MAX_SESSIONS: z.coerce
    .number()
    .int()
    .min(LINK_BOUNDS.maxSessions.min)
    .max(LINK_BOUNDS.maxSessions.max)
    .optional(),
  /** `1` allows a plain `ws://` HUB_URL to a non-loopback host (development only, ADR-020 §5). */
  DAISYCHESS_INSECURE: z.enum(['0', '1']).default('0'),
  // Hub store (ADR-020 §6, M24-4); only read by ROLE=hub.
  /** SQLite file of the hub; relative paths resolve against the working directory. Default apps/server/data/hub.sqlite */
  HUB_STORE_PATH: z.string().min(1).optional(),
  /** Alias of HUB_STORE_PATH (the name used in the M24-4 brief); both set must agree. */
  HUB_DB_PATH: z.string().min(1).optional(),
  /** Daily engine-time budget per pool token in minutes (UTC day); 0 = off. */
  POOL_DAILY_BUDGET_MIN: int(0, 1_440, 30),
  /** Days of `usage_daily` aggregates kept (the current UTC day counts as one). */
  USAGE_RETENTION_DAYS: int(1, 3_650, 90),
  // Hub routing (ADR-020 §4, M24-6); only read by ROLE=hub.
  /** `welcome.node.name` of the hub's built-in node `local` (its own engines). */
  HUB_LOCAL_NAME: z.string().trim().min(1).max(32).default('local'),
  /** Sessions of the hub's own pool donated to the shared pool (0 = `local` is not in the pool; ≤ MAX_SESSIONS). */
  HUB_LOCAL_POOL_SHARE: int(0, 256, 2),
  // Spot-checks and reputation of pool nodes (ADR-020 §5, M24-12); only read by ROLE=hub.
  /** Fraction (0…1) of eligible pool searches re-run on `local`; 0 = off. */
  SPOTCHECK_RATE: z.coerce.number().min(0).max(1).default(0.02),
  /** Checks started per rolling hour (bounds `local` CPU spent on checks). */
  SPOTCHECK_MAX_PER_HOUR: int(0, 3_600, 20),
  /** Max centipawns a node's move may be worse than `local`'s best at the same depth. */
  SPOTCHECK_TOLERANCE_CP: int(0, 10_000, 50),
  /** Max |reported − local| centipawns of the node's score; 0 = no score check. */
  SPOTCHECK_SCORE_TOLERANCE_CP: int(0, 100_000, 200),
  /** Pool searches below this reported depth are never checked. */
  SPOTCHECK_MIN_DEPTH: int(1, 245, 10),
  /** `local` checks at most this deep (the node's depth, capped). */
  SPOTCHECK_MAX_DEPTH: int(1, 245, 16),
  /** Time cap of one local check search; a check that misses the depth is inconclusive. */
  SPOTCHECK_MOVETIME_MS: int(100, 120_000, 5_000),
  /** Rolling reputation window (latest checks of the last 24 h). */
  SPOTCHECK_WINDOW: int(1, 1_000, 50),
  /** Checks in the window before a node can be marked suspect. */
  SPOTCHECK_MIN_CHECKS: int(1, 1_000, 10),
  /** Disagreement rate (0…1) above which a node becomes suspect. */
  SPOTCHECK_MAX_DISAGREE_RATE: z.coerce.number().min(0).max(1).default(0.2),
  /** Cool-down of a suspect episode in hours (then back to normal on probation). */
  SPOTCHECK_COOLDOWN_H: int(1, 24 * 365, 24),
  /** The suspect episode with this number disables the node instead. */
  SPOTCHECK_MAX_EPISODES: int(1, 1_000, 3),
  // Hub link endpoint `/link` (ADR-020 §3, M24-5); only read by ROLE=hub.
  /** Nodes older than this are refused with `node_outdated` (`major.minor.patch[-pre]`). */
  NODE_MIN_VERSION: z
    .string()
    .regex(LINK_BOUNDS.versionPattern, 'must be major.minor.patch[-prerelease]')
    .default('0.0.0'),
  /** `node.welcome.latestNodeVersion` (nodes below it log "a newer node is available"). Default: this server's version. */
  NODE_LATEST_VERSION: z
    .string()
    .regex(LINK_BOUNDS.versionPattern, 'must be major.minor.patch[-prerelease]')
    .optional(),
  /** Concurrent `/link` sockets per client address (handshaking or registered). */
  LINK_MAX_PER_IP: int(1, 1_000, 5),
  /** `node.welcome.heartbeatMs` (node.status cadence) and the hub's ping interval on `/link`. */
  LINK_HEARTBEAT_MS: int(
    LINK_BOUNDS.heartbeatMs.min,
    LINK_BOUNDS.heartbeatMs.max,
    LINK_DEFAULTS.heartbeatMs,
  ),
  /** `node.welcome.drainMs`: how long a draining node may finish running searches. */
  LINK_DRAIN_MS: int(LINK_BOUNDS.drainMs.min, LINK_BOUNDS.drainMs.max, LINK_DEFAULTS.drainMs),
  /** A `/link` socket without a valid `node.hello` is closed after this many ms. */
  LINK_HELLO_TIMEOUT_MS: int(1_000, 60_000, LINK_DEFAULTS.helloTimeoutMs),
  /** Frames per second accepted from one node link. */
  LINK_MAX_MSGS_PER_S: int(1, 100_000, LINK_DEFAULTS.maxMessagesPerSecond),
  // Operator portal API `/api/portal/*` (ADR-020 §2, §5, M24-9); only read by ROLE=hub.
  /**
   * Public origin of the hub (`https://play.daisychess.org`): setup links of new player tokens and the
   * portal's same-origin check. Unset: the first ALLOWED_ORIGINS entry (setup links) / the
   * request's host (Origin check).
   */
  PUBLIC_ORIGIN: z
    .string()
    .transform((value, ctx) => {
      const origin = normalizeOrigin(value.trim());
      if (!origin) {
        ctx.addIssue({
          code: 'custom',
          message: 'must be an http(s) origin, e.g. https://example.org',
        });
        return z.NEVER;
      }
      return origin;
    })
    .optional(),
  /** Comma-separated lichess usernames that are hub administrators (case-insensitive). */
  HUB_ADMIN_LICHESS: z.string().optional(),
  /**
   * Base URL of the loopback egress proxy to lichess (nginx, `deploy/nginx/lichess-egress.conf.snippet`):
   * the hub calls `<base>api/account` once per login. The unit itself keeps `IPAddressDeny=any`.
   */
  PORTAL_LICHESS_PROXY: z
    .string()
    .transform((value, ctx) => {
      let url: URL;
      try {
        url = new URL(value.trim());
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be an http(s) URL' });
        return z.NEVER;
      }
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
        ctx.addIssue({ code: 'custom', message: 'must be an http(s) URL without credentials' });
        return z.NEVER;
      }
      url.search = '';
      url.hash = '';
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      return url.toString();
    })
    .default(DEFAULT_LICHESS_PROXY),
  /** Timeout of the lichess account call at login. */
  PORTAL_LICHESS_TIMEOUT_MS: int(500, 60_000, 5_000),
  /** Nodes (not revoked) per operator. */
  PORTAL_MAX_NODES: int(1, 10_000, 10),
  /** Live (not revoked, not expired) player + pool tokens per operator. */
  PORTAL_MAX_TOKENS: int(1, 100_000, 100),
  /** Live pool tokens per operator (ADR-020 §2, §4.4). */
  POOL_TOKENS_PER_OPERATOR: int(0, 100_000, 20),
});

/** Operator portal (ADR-020 §2, §5, M24-9), env `PUBLIC_ORIGIN`, `HUB_ADMIN_LICHESS`, `PORTAL_*`. */
export interface PortalSettings {
  /** Normalised `scheme://host[:port]`, or null. */
  publicOrigin: string | null;
  /** Lower-case lichess ids (usernames) of the administrators. */
  adminLichessIds: readonly string[];
  /** Base URL of the lichess egress proxy, ending in `/`. */
  lichessProxy: string;
  lichessTimeoutMs: number;
  maxNodes: number;
  maxTokens: number;
  poolTokensPerOperator: number;
}

/** The hub's `/link` endpoint (ADR-020 §3, M24-5), env `NODE_MIN_VERSION`, `LINK_*`. */
export interface LinkSettings {
  minNodeVersion: string;
  /** Null: the hub's own version. */
  latestNodeVersion: string | null;
  maxPerIp: number;
  heartbeatMs: number;
  drainMs: number;
  helloTimeoutMs: number;
  maxMessagesPerSecond: number;
}

/** Hub persistence and token policy (ADR-020, M24-4), env `HUB_STORE_PATH` etc. */
export interface HubSettings {
  storePath: string;
  poolDailyBudgetMin: number;
  usageRetentionDays: number;
}

/** Hub routing (ADR-020 §4, M24-6), env `HUB_LOCAL_*`. */
export interface HubRouterSettings {
  /** `welcome.node.name` of the built-in node `local`. */
  localName: string;
  /** Pool share of `local` (already capped at MAX_SESSIONS). */
  localPoolShare: number;
}

/** Spot-checks and reputation (ADR-020 §5, M24-12), env `SPOTCHECK_*`. */
export interface SpotCheckSettings {
  rate: number;
  maxPerHour: number;
  toleranceCp: number;
  scoreToleranceCp: number;
  minDepth: number;
  maxDepth: number;
  movetimeMs: number;
  window: number;
  minChecks: number;
  maxDisagreeRate: number;
  cooldownMs: number;
  maxEpisodes: number;
}

/** Server-side review store (ADR-017), env `REVIEW_*`. */
export interface ReviewStoreSettings {
  enabled: boolean;
  path: string;
  maxBytes: number;
  putPerIpPerDay: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  maxSessions: number;
  maxSessionsPerIp: number;
  limits: Limits;
  engineIdleMs: number;
  sessionIdleMs: number;
  engineCrashResetMs: number;
  engineMaxConsecutiveCrashes: number;
  enginesConfig: string;
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  allowedOrigins: OriginPolicy;
  trustedProxies: TrustedProxies;
  /**
   * Access token (ADR-010/013): with one set, a `hello` without it gets a restricted welcome
   * (rooms only, no analysis). Null when the server is public.
   */
  accessToken: string | null;
  rooms: RoomConfig;
  reviewStore: ReviewStoreSettings;
  /** Human-like engines (ADR-019): Lc0 + Maia nets, registry group `maia`. */
  maia: MaiaSettings;
  /** Server role (ADR-020 §7). */
  role: ServerRole;
  /** Node side of the link; non-null exactly when `role === 'node'`. */
  node: NodeSettings | null;
  /** Hub store and token policy; only used with ROLE=hub. */
  hub: HubSettings;
  /** The hub's `/link` endpoint; only used with ROLE=hub. */
  link: LinkSettings;
  /** Hub routing; only used with ROLE=hub. */
  hubRouter: HubRouterSettings;
  /** Pool spot-checks; only used with ROLE=hub. */
  spotCheck: SpotCheckSettings;
  /** Operator portal API; only used with ROLE=hub. */
  portal: PortalSettings;
}

export type ServerRole = 'standalone' | 'hub' | 'node';

/** `ROLE=node` settings (ADR-020 §3, §7). */
export interface NodeSettings {
  /** Validated `ws(s)://…` URL of the hub's `/link`. */
  hubUrl: string;
  /** `dcn_…` node token (format-checked with `parseToken`). Never log it. */
  token: string;
  /** Local display name (logs, `/health/detail`); null when unset. */
  name: string | null;
  /** `node.hello.pool`. */
  pool: boolean;
  /** `node.hello.maxSessions`: node-wide session cap. */
  maxSessions: number;
}

/**
 * Validates `HUB_URL`: `wss://` always; plain `ws://` only to a loopback host (a hub on the same
 * machine, e.g. `pnpm dev:server`) or with `DAISYCHESS_INSECURE=1` (ADR-020 §5). Returns an error
 * message or null.
 */
export function checkHubUrl(raw: string, insecure: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'HUB_URL must be a ws:// or wss:// URL';
  }
  if (url.username || url.password) return 'HUB_URL must not contain credentials';
  if (url.protocol === 'wss:') return null;
  if (url.protocol !== 'ws:') return 'HUB_URL must be a ws:// or wss:// URL';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (loopback || insecure) return null;
  return 'HUB_URL must use wss:// (plain ws:// only to a loopback host or with DAISYCHESS_INSECURE=1)';
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function nodeSettings(e: z.infer<typeof EnvSchema>): NodeSettings | null {
  if (e.ROLE !== 'node') return null;
  const fail = (msg: string): never => {
    throw new Error(`Invalid server configuration: ${msg}`);
  };
  if (!e.HUB_URL) fail('ROLE=node requires HUB_URL (wss://<hub>/link)');
  const hubUrl = e.HUB_URL as string;
  const urlError = checkHubUrl(hubUrl, e.DAISYCHESS_INSECURE === '1');
  if (urlError) fail(urlError);
  // Strict format check without echoing the value (it is a secret).
  const parsed = parseToken(e.NODE_TOKEN);
  if (!parsed || parsed.kind !== 'node') {
    fail('ROLE=node requires NODE_TOKEN, a dcn_… node token from the portal');
  }
  const maxSessions = e.NODE_MAX_SESSIONS ?? e.MAX_SESSIONS;
  if (maxSessions > e.MAX_SESSIONS) {
    fail(`NODE_MAX_SESSIONS (${maxSessions}) must not exceed MAX_SESSIONS (${e.MAX_SESSIONS})`);
  }
  return {
    hubUrl,
    token: e.NODE_TOKEN as string,
    name: e.NODE_NAME ?? null,
    pool: e.NODE_POOL === 'on',
    maxSessions,
  };
}

export interface MaiaSettings {
  /** `MAIA=off` disables the group; binaries/weights missing disable it too (app.ts). */
  enabled: boolean;
  /** Total Lc0 processes across all Maia levels (`EnginePool` group cap). */
  maxProcesses: number;
}

/** Parses the environment; throws with a readable message on invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // Empty strings (e.g. `MAX_DEPTH=` in a .env file) mean "unset".
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid server configuration: ${details}`);
  }
  const e = parsed.data;
  if (e.MAX_SESSIONS_PER_IP !== undefined && e.MAX_SESSIONS_PER_IP > e.MAX_SESSIONS) {
    throw new Error(
      `Invalid server configuration: MAX_SESSIONS_PER_IP (${e.MAX_SESSIONS_PER_IP}) must not exceed MAX_SESSIONS (${e.MAX_SESSIONS})`,
    );
  }
  if (
    e.HUB_STORE_PATH !== undefined &&
    e.HUB_DB_PATH !== undefined &&
    path.resolve(e.HUB_STORE_PATH) !== path.resolve(e.HUB_DB_PATH)
  ) {
    throw new Error(
      'Invalid server configuration: HUB_STORE_PATH and HUB_DB_PATH are both set and differ',
    );
  }
  if (e.SPOTCHECK_MIN_CHECKS > e.SPOTCHECK_WINDOW) {
    throw new Error(
      `Invalid server configuration: SPOTCHECK_MIN_CHECKS (${e.SPOTCHECK_MIN_CHECKS}) must not exceed SPOTCHECK_WINDOW (${e.SPOTCHECK_WINDOW})`,
    );
  }
  const hubStorePath = e.HUB_STORE_PATH ?? e.HUB_DB_PATH;
  return {
    port: e.PORT,
    // A node has no public listener (ADR-020 §7): `/health` binds to loopback whatever HOST says
    // (the Docker image sets HOST=0.0.0.0 for the standalone role).
    host: e.ROLE === 'node' && !LOOPBACK_HOSTS.has(e.HOST) ? '127.0.0.1' : e.HOST,
    maxSessions: e.MAX_SESSIONS,
    // Default 2, but never above the global cap.
    maxSessionsPerIp: e.MAX_SESSIONS_PER_IP ?? Math.min(2, e.MAX_SESSIONS),
    limits: {
      maxDepth: e.MAX_DEPTH,
      maxMultipv: e.MAX_MULTIPV,
      maxThreads: e.MAX_THREADS,
      maxHash: e.MAX_HASH_MB,
      maxMovetimeMs: e.MAX_MOVETIME_MS,
      maxSessionsPerConnection: e.MAX_SESSIONS_PER_CONNECTION,
      maxNodes: e.MAX_NODES,
    },
    engineIdleMs: e.ENGINE_IDLE_MS,
    sessionIdleMs: e.SESSION_IDLE_MS,
    engineCrashResetMs: e.ENGINE_CRASH_RESET_MS,
    engineMaxConsecutiveCrashes: e.ENGINE_MAX_CONSECUTIVE_CRASHES,
    enginesConfig: e.ENGINES_CONFIG
      ? path.resolve(e.ENGINES_CONFIG)
      : path.join(PACKAGE_DIR, 'engines.json'),
    logLevel: e.LOG_LEVEL,
    allowedOrigins: e.ALLOWED_ORIGINS ?? null,
    trustedProxies: e.TRUSTED_PROXIES ?? [],
    accessToken: e.ACCESS_TOKEN ?? null,
    rooms: {
      maxRooms: e.ROOM_MAX_ROOMS,
      maxSpectators: e.ROOM_MAX_SPECTATORS,
      createRateLimit: { max: e.ROOM_CREATE_PER_IP, windowMs: e.ROOM_CREATE_WINDOW_MS },
      waitingTtlMs: e.ROOM_WAITING_TTL_MS,
      finishedTtlMs: e.ROOM_FINISHED_TTL_MS,
      idleTtlMs: e.ROOM_IDLE_TTL_MS,
      claimGraceMs: e.ROOM_CLAIM_GRACE_MS,
    },
    reviewStore: {
      enabled: e.REVIEW_STORE === 'on',
      path: e.REVIEW_STORE_PATH
        ? path.resolve(e.REVIEW_STORE_PATH)
        : path.join(PACKAGE_DIR, 'data', 'reviews.sqlite'),
      maxBytes: e.REVIEW_STORE_MAX_BYTES,
      putPerIpPerDay: e.REVIEW_PUT_PER_IP_PER_DAY,
    },
    maia: { enabled: e.MAIA === 'on', maxProcesses: e.MAIA_MAX_PROCESSES },
    role: e.ROLE,
    node: nodeSettings(e),
    hub: {
      storePath: hubStorePath
        ? path.resolve(hubStorePath)
        : path.join(PACKAGE_DIR, 'data', 'hub.sqlite'),
      poolDailyBudgetMin: e.POOL_DAILY_BUDGET_MIN,
      usageRetentionDays: e.USAGE_RETENTION_DAYS,
    },
    hubRouter: {
      localName: e.HUB_LOCAL_NAME,
      localPoolShare: Math.min(e.HUB_LOCAL_POOL_SHARE, e.MAX_SESSIONS),
    },
    spotCheck: {
      rate: e.SPOTCHECK_RATE,
      maxPerHour: e.SPOTCHECK_MAX_PER_HOUR,
      toleranceCp: e.SPOTCHECK_TOLERANCE_CP,
      scoreToleranceCp: e.SPOTCHECK_SCORE_TOLERANCE_CP,
      minDepth: e.SPOTCHECK_MIN_DEPTH,
      maxDepth: e.SPOTCHECK_MAX_DEPTH,
      movetimeMs: e.SPOTCHECK_MOVETIME_MS,
      window: e.SPOTCHECK_WINDOW,
      minChecks: e.SPOTCHECK_MIN_CHECKS,
      maxDisagreeRate: e.SPOTCHECK_MAX_DISAGREE_RATE,
      cooldownMs: e.SPOTCHECK_COOLDOWN_H * 3_600_000,
      maxEpisodes: e.SPOTCHECK_MAX_EPISODES,
    },
    portal: {
      publicOrigin: e.PUBLIC_ORIGIN ?? null,
      adminLichessIds: [
        ...new Set(
          (e.HUB_ADMIN_LICHESS ?? '')
            .split(',')
            .map((u) => u.trim().toLowerCase())
            .filter((u) => u.length > 0),
        ),
      ],
      lichessProxy: e.PORTAL_LICHESS_PROXY,
      lichessTimeoutMs: e.PORTAL_LICHESS_TIMEOUT_MS,
      maxNodes: e.PORTAL_MAX_NODES,
      maxTokens: e.PORTAL_MAX_TOKENS,
      poolTokensPerOperator: e.POOL_TOKENS_PER_OPERATOR,
    },
    link: {
      minNodeVersion: e.NODE_MIN_VERSION,
      latestNodeVersion: e.NODE_LATEST_VERSION ?? null,
      maxPerIp: e.LINK_MAX_PER_IP,
      heartbeatMs: e.LINK_HEARTBEAT_MS,
      drainMs: e.LINK_DRAIN_MS,
      helloTimeoutMs: e.LINK_HELLO_TIMEOUT_MS,
      maxMessagesPerSecond: e.LINK_MAX_MSGS_PER_S,
    },
  };
}
