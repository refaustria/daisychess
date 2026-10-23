import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEFAULT_LIMITS, PROTOCOL_BOUNDS, type Limits } from '@chesslab/engine-core';
import { parseAllowedOrigins, type OriginPolicy } from './ws/origin.js';

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
});

export interface ServerConfig {
  port: number;
  host: string;
  maxSessions: number;
  limits: Limits;
  engineIdleMs: number;
  sessionIdleMs: number;
  enginesConfig: string;
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  allowedOrigins: OriginPolicy;
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
  return {
    port: e.PORT,
    host: e.HOST,
    maxSessions: e.MAX_SESSIONS,
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
    enginesConfig: e.ENGINES_CONFIG
      ? path.resolve(e.ENGINES_CONFIG)
      : path.join(PACKAGE_DIR, 'engines.json'),
    logLevel: e.LOG_LEVEL,
    allowedOrigins: e.ALLOWED_ORIGINS ?? null,
  };
}
