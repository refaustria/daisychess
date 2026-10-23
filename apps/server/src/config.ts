import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  DEFAULT_LIMITS,
  MAX_TOKEN_LENGTH,
  PROTOCOL_BOUNDS,
  type Limits,
} from '@chesslab/engine-core';
import { parseAllowedOrigins, type OriginPolicy } from './ws/origin.js';
import { parseTrustedProxies, type TrustedProxies } from './ws/clientIp.js';

/** apps/server (one level above src/ or dist/). */
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const int = (min: number, max: number, def: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

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
});

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
  /** Required `hello.token`, or null when the server is public. */
  accessToken: string | null;
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
  return {
    port: e.PORT,
    host: e.HOST,
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
  };
}
