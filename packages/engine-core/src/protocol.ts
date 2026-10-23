/**
 * Browser ⇄ server WebSocket protocol (see docs/DECISIONS.md ADR-006).
 *
 * JSON text frames, one message per frame, discriminated by `type`.
 *
 * Lifecycle
 * - The first client message must be `hello`; the server answers with `welcome` (or an `error`
 *   with code `protocol_mismatch` and closes). Anything else before `hello` → `handshake_required`.
 * - A *session* leases one engine instance. Sessions are created implicitly by the first
 *   `analyze` for a client-chosen `sessionId` and released by `release`, by the server after an
 *   idle period (no running search) or when the connection closes (all sessions are stopped and
 *   released). A released session is transparently recreated by the next `analyze`.
 * - Each `analyze` starts a *search* identified by `(sessionId, searchId)`. An `analyze` for a
 *   session whose search is still running stops that search first (its terminal `bestmove` with
 *   `reason: 'stopped'` is delivered before any `info` of the new search).
 * - Exactly one terminal message ends every accepted search: `bestmove`, or an `error` carrying
 *   its `searchId`. An `error` with `sessionId` only concerns that session (`engine_crashed`
 *   releases it); an `error` without `sessionId` concerns the connection.
 * - `info` scores are **relative to the side to move** (raw UCI). The client converts to
 *   White's point of view with `infoToWhitePov(info, sideToMove(fen))`, exactly like the WASM
 *   client does, so both backends share one conversion path.
 * - Unknown fields are stripped (not rejected); unknown `type` is rejected.
 */
import { z } from 'zod';
import type { BestMove, EngineInfo } from './types.js';

/** Bumped on any incompatible change. `hello` and `welcome` carry it; mismatch → `protocol_mismatch`. */
export const PROTOCOL_VERSION = 1;

/** Maximum size of one WebSocket text frame in either direction (the server sets `maxPayload` to it). */
export const MAX_MESSAGE_BYTES = 16 * 1024;

export const PROTOCOL_ERROR_CODES = [
  /** Not JSON, unknown `type`, or failed schema validation. */
  'invalid_message',
  /** `hello.protocolVersion` differs from the server's `PROTOCOL_VERSION`; the server closes the connection. */
  'protocol_mismatch',
  /** A message other than `hello` arrived before the handshake. */
  'handshake_required',
  /** `analyze.engine` is not in the registry or is disabled. */
  'unknown_engine',
  /** A per-connection limit from `welcome.limits` was exceeded (depth, multipv, threads, hash, movetime, sessions). */
  'limit_exceeded',
  /** Server-wide capacity exhausted (global session cap, no free engine instance). Retry later. */
  'no_capacity',
  /** `stop` for a session this connection does not own (or that was released). */
  'session_not_found',
  /** The engine process died; the session is released and the running search (if any) terminated. */
  'engine_crashed',
  /** Too many messages; the server may close the connection. */
  'rate_limited',
  /** Unexpected server failure. */
  'internal_error',
] as const;
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

/**
 * Hard ceilings baked into the schemas. A server's {@link Limits} can only be stricter;
 * exceeding them fails validation (`invalid_message`), exceeding `Limits` gives `limit_exceeded`.
 */
export const PROTOCOL_BOUNDS = {
  depth: { min: 1, max: 99 },
  movetimeMs: { min: 100, max: 600_000 },
  multipv: { min: 1, max: 10 },
  threads: { min: 1, max: 64 },
  hashMb: { min: 1, max: 16_384 },
  sessionsPerConnection: { min: 1, max: 16 },
  /** `sessionId`: 1–64 characters of `[A-Za-z0-9_-]`. */
  sessionIdPattern: /^[A-Za-z0-9_-]{1,64}$/,
  /** Engine ids (same rule as `engines.json`). */
  engineIdPattern: /^[a-z0-9][a-z0-9_-]{0,63}$/i,
  fenMaxLength: 100,
  pvMaxLength: 300,
} as const;

/** Per-connection limits the server enforces; announced in `welcome.limits`. */
export interface Limits {
  maxDepth: number;
  maxMultipv: number;
  maxThreads: number;
  /** UCI `Hash` in MB. */
  maxHash: number;
  maxMovetimeMs: number;
  maxSessionsPerConnection: number;
}

/** Defaults the server uses when no environment variable overrides them. */
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxDepth: 30,
  maxMultipv: 5,
  maxThreads: 4,
  maxHash: 512,
  maxMovetimeMs: 600_000,
  maxSessionsPerConnection: 2,
});

// ---------------------------------------------------------------------------------------------
// Building blocks

const FEN_PATTERN =
  /^([pnbrqkPNBRQK1-8]{1,8})(?:\/([pnbrqkPNBRQK1-8]{1,8})){7} [wb] (-|K?Q?k?q?|[A-Ha-h]{1,4}) (-|[a-h][36])(?: (\d{1,4}) (\d{1,4}))?$/;

/**
 * Syntactic FEN check: 8 ranks that each add up to 8 squares, exactly one king per side, side to
 * move, castling rights (standard or Shredder/Chess960 letters), en-passant square, optional
 * half-move/full-move counters. Legality beyond that (checks, pawn ranks) is the engine's business.
 */
export function isValidFen(fen: string): boolean {
  if (fen.length > PROTOCOL_BOUNDS.fenMaxLength) return false;
  const m = FEN_PATTERN.exec(fen);
  if (!m) return false;
  if (m[3] === '') return false; // empty castling field (the optional-letters branch matched nothing)
  const placement = fen.slice(0, fen.indexOf(' '));
  let whiteKings = 0;
  let blackKings = 0;
  for (const rank of placement.split('/')) {
    let squares = 0;
    for (const ch of rank) {
      if (ch >= '1' && ch <= '8') squares += Number(ch);
      else {
        squares += 1;
        if (ch === 'K') whiteKings++;
        else if (ch === 'k') blackKings++;
      }
    }
    if (squares !== 8) return false;
  }
  return whiteKings === 1 && blackKings === 1;
}

export const FenSchema = z
  .string()
  .max(
    PROTOCOL_BOUNDS.fenMaxLength,
    `fen must be at most ${PROTOCOL_BOUNDS.fenMaxLength} characters`,
  )
  .refine(
    isValidFen,
    'fen is not a syntactically valid FEN (8 ranks, one king per side, side, castling, ep)',
  );

export const SessionIdSchema = z
  .string()
  .regex(PROTOCOL_BOUNDS.sessionIdPattern, 'sessionId must be 1-64 characters of [A-Za-z0-9_-]');

/** Client-chosen, unique per session (a monotonic counter is recommended). */
export const SearchIdSchema = z
  .number()
  .int('searchId must be an integer')
  .min(1, 'searchId must be >= 1')
  .max(Number.MAX_SAFE_INTEGER);

export const EngineIdSchema = z
  .string()
  .regex(
    PROTOCOL_BOUNDS.engineIdPattern,
    'engine id must be 1-64 alphanumeric characters (plus - and _)',
  );

const UciMoveSchema = z
  .string()
  .regex(/^[a-h][1-8][a-h][1-8][nbrq]?$/, 'move must be in UCI notation (e.g. e2e4, e7e8q)');

const range = (name: string, { min, max }: { min: number; max: number }) =>
  z
    .number()
    .int(`${name} must be an integer`)
    .min(min, `${name} must be >= ${min}`)
    .max(max, `${name} must be <= ${max}`);

/** Strict so that `{ cp, mate }` is rejected instead of silently becoming `{ cp }`. */
export const ScoreSchema = z.union(
  [
    z.strictObject({ cp: range('score.cp', { min: -100_000, max: 100_000 }) }),
    z.strictObject({ mate: range('score.mate', { min: -1_000, max: 1_000 }) }),
  ],
  { error: 'score must be either { cp } or { mate } with an integer value' },
);

const nonNegativeInt = (name: string) =>
  z.number().int(`${name} must be an integer`).nonnegative(`${name} must be >= 0`);

/** Mirrors {@link EngineInfo}. Scores are side-to-move (raw UCI) on the wire. */
export const EngineInfoSchema = z.object({
  depth: range('depth', { min: 0, max: 1_000 }),
  seldepth: range('seldepth', { min: 0, max: 1_000 }).optional(),
  multipv: range('multipv', { min: 1, max: 500 }),
  score: ScoreSchema,
  pv: z
    .array(UciMoveSchema)
    .min(1, 'pv must contain at least one move')
    .max(PROTOCOL_BOUNDS.pvMaxLength),
  nps: nonNegativeInt('nps').optional(),
  nodes: nonNegativeInt('nodes').optional(),
  time: nonNegativeInt('time').optional(),
});

/** Mirrors {@link BestMove}. */
export const BestMoveSchema = z.object({ move: UciMoveSchema, ponder: UciMoveSchema.optional() });

export const LimitsSchema = z.object({
  maxDepth: range('maxDepth', PROTOCOL_BOUNDS.depth),
  maxMultipv: range('maxMultipv', PROTOCOL_BOUNDS.multipv),
  maxThreads: range('maxThreads', PROTOCOL_BOUNDS.threads),
  maxHash: range('maxHash', PROTOCOL_BOUNDS.hashMb),
  maxMovetimeMs: range('maxMovetimeMs', PROTOCOL_BOUNDS.movetimeMs),
  maxSessionsPerConnection: range(
    'maxSessionsPerConnection',
    PROTOCOL_BOUNDS.sessionsPerConnection,
  ),
});

/** One entry of the server's engine registry as shown to clients (no paths or internals). */
export const EngineDescriptorSchema = z.object({
  id: EngineIdSchema,
  /** Display name, e.g. "Stockfish 19". */
  name: z.string().min(1).max(64),
  /** Disabled engines are listed for information but rejected with `unknown_engine`. */
  enabled: z.boolean(),
  /** Values used when `analyze` omits `threads`/`hash`. */
  defaults: z.object({
    threads: range('defaults.threads', PROTOCOL_BOUNDS.threads),
    hash: range('defaults.hash', PROTOCOL_BOUNDS.hashMb),
  }),
});

// ---------------------------------------------------------------------------------------------
// Client → server

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int().min(1),
  client: z
    .object({
      name: z.string().min(1).max(64),
      version: z.string().max(32).optional(),
    })
    .optional(),
});

/**
 * Starts (or replaces) the search of session `sessionId`. Without `depth` and `movetime` the
 * search is infinite and runs until `stop`, `release`, a replacing `analyze` or a server-side cap
 * (`bestmove.reason: 'limit'`). `threads`/`hash` default to the engine's `defaults` and are
 * applied to the leased engine instance (changing them restarts nothing but the search).
 */
export const AnalyzeMessageSchema = z.object({
  type: z.literal('analyze'),
  sessionId: SessionIdSchema,
  searchId: SearchIdSchema,
  engine: EngineIdSchema,
  fen: FenSchema,
  multipv: range('multipv', PROTOCOL_BOUNDS.multipv).optional(),
  depth: range('depth', PROTOCOL_BOUNDS.depth).optional(),
  movetime: range('movetime', PROTOCOL_BOUNDS.movetimeMs).optional(),
  threads: range('threads', PROTOCOL_BOUNDS.threads).optional(),
  hash: range('hash', PROTOCOL_BOUNDS.hashMb).optional(),
});

/** Stops the running search of a session (its `bestmove` follows). No-op when nothing runs. */
export const StopMessageSchema = z.object({ type: z.literal('stop'), sessionId: SessionIdSchema });

/** Stops and frees the session's engine instance. Idempotent (unknown sessions are ignored). */
export const ReleaseMessageSchema = z.object({
  type: z.literal('release'),
  sessionId: SessionIdSchema,
});

/** `t` (client timestamp) is echoed in `pong` for round-trip measurement. */
export const PingMessageSchema = z.object({ type: z.literal('ping'), t: z.number().optional() });

export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  AnalyzeMessageSchema,
  StopMessageSchema,
  ReleaseMessageSchema,
  PingMessageSchema,
]);

export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type AnalyzeMessage = z.infer<typeof AnalyzeMessageSchema>;
export type StopMessage = z.infer<typeof StopMessageSchema>;
export type ReleaseMessage = z.infer<typeof ReleaseMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------------------------
// Server → client

export const WelcomeMessageSchema = z.object({
  type: z.literal('welcome'),
  protocolVersion: z.number().int().min(1),
  serverVersion: z.string().max(64),
  limits: LimitsSchema,
  engines: z.array(EngineDescriptorSchema).max(64),
});

export const InfoMessageSchema = z.object({
  type: z.literal('info'),
  sessionId: SessionIdSchema,
  searchId: SearchIdSchema,
  info: EngineInfoSchema,
});

/**
 * Terminal message of a search. `bestMove` is null when the engine reported `(none)` (mate or
 * stalemate) or the search was stopped before it produced a move.
 * `reason`: `completed` (depth/movetime reached), `stopped` (client `stop`/`release`/replacing
 * `analyze`), `limit` (server-side cap, e.g. maximum wall time for infinite searches).
 */
export const BestMoveMessageSchema = z.object({
  type: z.literal('bestmove'),
  sessionId: SessionIdSchema,
  searchId: SearchIdSchema,
  bestMove: BestMoveSchema.nullable(),
  reason: z.enum(['completed', 'stopped', 'limit']),
});

export const ErrorMessageSchema = z
  .object({
    type: z.literal('error'),
    code: z.enum(PROTOCOL_ERROR_CODES),
    message: z.string().max(1_000),
    sessionId: SessionIdSchema.optional(),
    searchId: SearchIdSchema.optional(),
  })
  .refine((e) => e.searchId === undefined || e.sessionId !== undefined, {
    path: ['searchId'],
    message: 'searchId requires sessionId',
  });

export const PongMessageSchema = z.object({ type: z.literal('pong'), t: z.number().optional() });

export const ServerMessageSchema = z.discriminatedUnion('type', [
  WelcomeMessageSchema,
  InfoMessageSchema,
  BestMoveMessageSchema,
  ErrorMessageSchema,
  PongMessageSchema,
]);

export type EngineDescriptor = z.infer<typeof EngineDescriptorSchema>;
export type WelcomeMessage = z.infer<typeof WelcomeMessageSchema>;
export type InfoMessage = z.infer<typeof InfoMessageSchema>;
export type BestMoveMessage = z.infer<typeof BestMoveMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// Compile-time guarantee that the wire types stay interchangeable with the engine types.
type Assignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const infoMatchesEngineInfo: Assignable<z.infer<typeof EngineInfoSchema>, EngineInfo> = true;
const bestMoveMatchesBestMove: Assignable<z.infer<typeof BestMoveSchema>, BestMove> = true;
void infoMatchesEngineInfo;
void bestMoveMatchesBestMove;

// ---------------------------------------------------------------------------------------------
// Parsing

export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };

const CLIENT_TYPES = ClientMessageSchema.options.map((o) => o.shape.type.value);
const SERVER_TYPES = ServerMessageSchema.options.map((o) => o.shape.type.value);

function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
}

function parseWith<T>(
  schema: z.ZodType<T>,
  knownTypes: readonly string[],
  input: unknown,
): ParseResult<T> {
  let value = input;
  if (typeof input === 'string') {
    if (input.length > MAX_MESSAGE_BYTES)
      return { ok: false, error: `message exceeds ${MAX_MESSAGE_BYTES} bytes` };
    try {
      value = JSON.parse(input);
    } catch (err) {
      return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'message must be a JSON object' };
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !knownTypes.includes(type)) {
    return { ok: false, error: `unknown message type ${JSON.stringify(type)}` };
  }
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, message: result.data }
    : { ok: false, error: `${type}: ${formatIssues(result.error.issues)}` };
}

/** Validates a client→server message (JSON text or an already parsed value). Unknown fields are stripped. */
export function parseClientMessage(input: unknown): ParseResult<ClientMessage> {
  return parseWith(ClientMessageSchema, CLIENT_TYPES, input);
}

/** Validates a server→client message (JSON text or an already parsed value). Unknown fields are stripped. */
export function parseServerMessage(input: unknown): ParseResult<ServerMessage> {
  return parseWith(ServerMessageSchema, SERVER_TYPES, input);
}

/**
 * Checks an `analyze` message against a server's {@link Limits}. Returns a human-readable
 * description of the first violation (to be sent as `limit_exceeded`) or null when within limits.
 * The client uses it with `welcome.limits` to fail fast; the server uses it with its own limits.
 */
export function checkAnalyzeLimits(msg: AnalyzeMessage, limits: Limits): string | null {
  const checks: [name: string, value: number | undefined, max: number][] = [
    ['depth', msg.depth, limits.maxDepth],
    ['movetime', msg.movetime, limits.maxMovetimeMs],
    ['multipv', msg.multipv, limits.maxMultipv],
    ['threads', msg.threads, limits.maxThreads],
    ['hash', msg.hash, limits.maxHash],
  ];
  for (const [name, value, max] of checks) {
    if (value !== undefined && value > max)
      return `${name} ${value} exceeds the server limit of ${max}`;
  }
  return null;
}
