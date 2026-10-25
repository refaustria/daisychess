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
 *
 * Rooms (ADR-013, additive in protocol 1): `room.*` messages let two people play each other on
 * the server (link + nickname, no account). The server validates moves and runs the clocks; after
 * every change it sends the full `room.state` snapshot to every member. Room-level failures come
 * as `room.error`; envelope-level failures (`invalid_message`, `rate_limited`, …) stay on `error`.
 *
 * Review store (ADR-017, additive in protocol 1): `review.*` messages read and write finished game
 * reviews and position results on the server (SQLite), keyed by the game's hash (`reviewGameKey`),
 * so every device gets the same review for the same game. Reads are open; writes need the access
 * token. The record-carrying frames may be up to `MAX_LARGE_MESSAGE_BYTES`.
 */
import { z } from 'zod';
import { MOVE_CLASSES, type MoveClass, type ReviewSummary } from './review.js';
import { REVIEW_PRESETS } from './reviewKey.js';
import type { BestMove, EngineInfo } from './types.js';

/** Bumped on any incompatible change. `hello` and `welcome` carry it; mismatch → `protocol_mismatch`. */
export const PROTOCOL_VERSION = 1;

/**
 * Maximum size of one WebSocket text frame in either direction — except the record-carrying
 * review frames (ADR-017), see {@link MAX_LARGE_MESSAGE_BYTES} and {@link LARGE_MESSAGE_TYPES}.
 */
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
  /**
   * The server requires an access token (ADR-010) and this connection's `hello.token` was missing
   * or wrong, so analysis is not available (`welcome.capabilities.analysis` is false; ADR-013).
   * Sent for `analyze`; before ADR-013 it was sent for `hello` and the socket closed (1008).
   */
  'unauthorized',
  /**
   * `analyze` while this connection plays in a room whose game is running (fair play, ADR-013).
   * Added in protocol 1 (additive).
   */
  'forbidden',
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
 * FEN check mirroring what Stockfish 19 (`Position::set`) rejects — and it rejects by
 * terminating the process (`terminate_on_critical_error`), so every rule here keeps a
 * client-supplied position from killing a native engine (docs/SECURITY.md):
 *
 * - 8 ranks of 8 squares, at most 32 pieces, exactly one king per side;
 * - no pawns on the first or eighth rank, at most 8 pawns per side, and promoted pieces
 *   (knights/bishops/rooks beyond 2, queens beyond 1) at most equal to the missing pawns;
 * - side to move, castling rights (standard or Shredder/Chess960 letters; wrong ones are
 *   sanitised by the engine, so they are accepted), optional half-move/full-move counters;
 * - the en-passant square, when given, is on rank 6 with White to move / rank 3 with Black to
 *   move (an ep square without a capturable pawn is dropped by the engine, not rejected);
 * - the side **not** to move is not in check (that includes adjacent kings).
 *
 * Anything else (unreachable positions, both sides having no legal moves) is the engine's business.
 */
export function isValidFen(fen: string): boolean {
  if (fen.length > PROTOCOL_BOUNDS.fenMaxLength) return false;
  const m = FEN_PATTERN.exec(fen);
  if (!m) return false;
  if (m[3] === '') return false; // empty castling field (the optional-letters branch matched nothing)
  const [placement, side, , ep] = fen.split(' ') as [string, 'w' | 'b', string, string];
  const board = parseBoard(placement);
  if (!board) return false;
  const sideToMove = side;
  if (ep !== '-' && ep[1] !== (sideToMove === 'w' ? '6' : '3')) return false;
  const opponent = sideToMove === 'w' ? 'b' : 'w';
  const king = board.kings[opponent];
  return king !== undefined && !isAttacked(board.squares, king, sideToMove);
}

/**
 * Board as 64 chars indexed by `rank * 8 + file` (rank 0 = rank 1, file 0 = a), '.' for empty.
 * Returns null when a rank does not add up to 8 squares or a material rule is violated.
 */
interface Board {
  squares: string[];
  kings: { w?: number; b?: number };
}

function parseBoard(placement: string): Board | null {
  const squares: string[] = new Array<string>(64).fill('.');
  const kings: Board['kings'] = {};
  const counts: Record<string, number> = {};
  const ranks = placement.split('/');
  if (ranks.length !== 8) return null;
  let pieces = 0;
  for (let r = 0; r < 8; r++) {
    const rank = 7 - r;
    let file = 0;
    for (const ch of ranks[r]!) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      if (file >= 8) return null;
      if (++pieces > 32) return null;
      if ((ch === 'p' || ch === 'P') && (rank === 0 || rank === 7)) return null;
      squares[rank * 8 + file] = ch;
      counts[ch] = (counts[ch] ?? 0) + 1;
      if (ch === 'K') kings.w = rank * 8 + file;
      else if (ch === 'k') kings.b = rank * 8 + file;
      file++;
    }
    if (file !== 8) return null;
  }
  if ((counts.K ?? 0) !== 1 || (counts.k ?? 0) !== 1) return null;
  for (const side of ['w', 'b'] as const) {
    const c = (piece: string) => counts[side === 'w' ? piece.toUpperCase() : piece] ?? 0;
    const pawns = c('p');
    if (pawns > 8) return null;
    const promoted =
      Math.max(c('n') - 2, 0) +
      Math.max(c('b') - 2, 0) +
      Math.max(c('r') - 2, 0) +
      Math.max(c('q') - 1, 0);
    if (promoted > 8 - pawns) return null;
  }
  return { squares, kings };
}

const KNIGHT_STEPS = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
] as const;
const KING_STEPS = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
] as const;
const ROOK_DIRS = KING_STEPS.filter(([df, dr]) => df === 0 || dr === 0);
const BISHOP_DIRS = KING_STEPS.filter(([df, dr]) => df !== 0 && dr !== 0);

/** Whether any piece of `by` attacks `square` (0..63) on `squares` (see {@link Board}). */
function isAttacked(squares: string[], square: number, by: 'w' | 'b'): boolean {
  const file = square % 8;
  const rank = Math.floor(square / 8);
  const own = (piece: string) => (by === 'w' ? piece.toUpperCase() : piece);
  const at = (f: number, r: number): string | null =>
    f < 0 || f > 7 || r < 0 || r > 7 ? null : squares[r * 8 + f]!;
  // Pawns attack diagonally forward: a white pawn on rank-1 attacks `square`.
  const pawnRank = by === 'w' ? rank - 1 : rank + 1;
  if (at(file - 1, pawnRank) === own('p') || at(file + 1, pawnRank) === own('p')) return true;
  for (const [df, dr] of KNIGHT_STEPS) if (at(file + df, rank + dr) === own('n')) return true;
  for (const [df, dr] of KING_STEPS) if (at(file + df, rank + dr) === own('k')) return true;
  const slides = (dirs: readonly (readonly [number, number])[], pieces: string[]): boolean => {
    for (const [df, dr] of dirs) {
      let f = file + df;
      let r = rank + dr;
      let p: string | null;
      while ((p = at(f, r)) === '.') {
        f += df;
        r += dr;
      }
      if (p !== null && pieces.includes(p)) return true;
    }
    return false;
  };
  return slides(ROOK_DIRS, [own('r'), own('q')]) || slides(BISHOP_DIRS, [own('b'), own('q')]);
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

/** A move in UCI notation; promotions carry the piece as 5th character (`e7e8q`). */
export const UciMoveSchema = z
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
// Rooms (ADR-013): building blocks

/** Hard bounds of the room messages (the server's `RoomConfig` can only be stricter). */
export const ROOM_BOUNDS = {
  /** Room ids are URL-safe base64 of ≥ 96 random bits (the server uses 128 → 22 chars). */
  roomIdPattern: /^[A-Za-z0-9_-]{16,64}$/,
  /** Player tokens are URL-safe base64 of ≥ 128 random bits (the server uses 256 → 43 chars). */
  playerTokenPattern: /^[A-Za-z0-9_-]{22,128}$/,
  /** Nickname length after {@link normalizeNick}. */
  nick: { min: 1, max: 20 },
  /** Raw nickname length before normalisation (keeps the frame small). */
  nickRawMaxLength: 100,
  /** Same range as the custom time control of local play (0.25–180 min, 0–60 s). */
  clockInitialMs: { min: 15_000, max: 10_800_000 },
  clockIncrementMs: { min: 0, max: 60_000 },
  /** A game is adjudicated a draw at this many plies (keeps `room.state` under MAX_MESSAGE_BYTES). */
  maxPlies: 1_000,
} as const;

export const ROOM_ERROR_CODES = [
  /** No room with this id (never existed, expired or was deleted). */
  'room_not_found',
  /** Both seats are taken and the spectator cap is reached. */
  'room_full',
  /** `room.attach.playerToken` does not belong to a seat of this room. */
  'bad_token',
  /** The sender is not a player of this room (spectator or not attached). */
  'not_a_player',
  /** `room.move` when it is the opponent's turn. */
  'not_your_turn',
  /** `room.move` with an illegal move (or a promotion without a piece). */
  'illegal_move',
  /** The action is not allowed in the room's current state (e.g. `room.abort` after move 2). */
  'bad_state',
  /** Room creation refused: server cap (`ROOM_MAX_ROOMS`) or the per-address creation rate. */
  'too_many_rooms',
] as const;
export type RoomErrorCode = (typeof ROOM_ERROR_CODES)[number];

export const ROOM_STATUSES = ['waiting', 'playing', 'finished'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const ROOM_RESULTS = ['1-0', '0-1', '1/2-1/2'] as const;
export type RoomResult = (typeof ROOM_RESULTS)[number];

/**
 * Why a room's game ended. `abort` (before both sides moved, or a waiting room cancelled) and
 * `abandoned` without a `result` mean no game was played; `abandoned` with a `result` is a
 * claimed win. `timeout` can be a draw (the opponent could not mate). `draw` covers the
 * automatic draws (threefold repetition, 50-move rule, insufficient material, ply cap).
 */
export const ROOM_END_REASONS = [
  'checkmate',
  'stalemate',
  'draw',
  'resign',
  'timeout',
  'abort',
  'abandoned',
  'agreement',
] as const;
export type RoomEndReason = (typeof ROOM_END_REASONS)[number];

export const RoomIdSchema = z
  .string()
  .regex(ROOM_BOUNDS.roomIdPattern, 'roomId must be 16-64 characters of [A-Za-z0-9_-]');

export const PlayerTokenSchema = z
  .string()
  .regex(ROOM_BOUNDS.playerTokenPattern, 'playerToken must be 22-128 characters of [A-Za-z0-9_-]');

/**
 * Nickname normalisation applied by the schema (and usable by a client before sending):
 * control, format and bidi characters removed, whitespace collapsed to single spaces, trimmed.
 */
/* eslint-disable no-control-regex -- removing control characters is the purpose */
const NICK_STRIP =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u2064\uFEFF]/g;
/* eslint-enable no-control-regex */

export function normalizeNick(raw: string): string {
  return raw.replace(NICK_STRIP, '').replace(/\s+/g, ' ').trim();
}

/** A nickname: normalised with {@link normalizeNick}, then 1–20 characters. */
export const NickSchema = z
  .string()
  .max(
    ROOM_BOUNDS.nickRawMaxLength,
    `nick must be at most ${ROOM_BOUNDS.nickRawMaxLength} characters`,
  )
  .transform(normalizeNick)
  .pipe(
    z
      .string()
      .min(ROOM_BOUNDS.nick.min, 'nick must not be empty')
      .max(ROOM_BOUNDS.nick.max, `nick must be at most ${ROOM_BOUNDS.nick.max} characters`),
  );

export const RoomSideSchema = z.enum(['white', 'black']);
export type RoomSide = z.infer<typeof RoomSideSchema>;

/** The host's colour choice; `random` is decided by the server at creation. */
export const RoomColorChoiceSchema = z.enum(['white', 'black', 'random']);
export type RoomColorChoice = z.infer<typeof RoomColorChoiceSchema>;

/** Fischer clock setting (same shape as the web's `ClockSetting`). */
export const RoomClockSettingSchema = z.object({
  initialMs: range('clock.initialMs', ROOM_BOUNDS.clockInitialMs),
  incrementMs: range('clock.incrementMs', ROOM_BOUNDS.clockIncrementMs),
});
export type RoomClockSetting = z.infer<typeof RoomClockSettingSchema>;

/**
 * Clock state in a snapshot. `white`/`black` are the remaining ms as of `room.state.serverTime`;
 * only `running`'s time decreases between snapshots. `running` is null before both sides have
 * moved (the first two plies are untimed, like lichess) and after the game.
 */
export const RoomClockStateSchema = z.object({
  initialMs: range('clock.initialMs', ROOM_BOUNDS.clockInitialMs),
  incrementMs: range('clock.incrementMs', ROOM_BOUNDS.clockIncrementMs),
  white: nonNegativeInt('clock.white'),
  black: nonNegativeInt('clock.black'),
  running: RoomSideSchema.nullable(),
});
export type RoomClockState = z.infer<typeof RoomClockStateSchema>;

export const RoomPlayerSchema = z.object({
  nick: z.string().min(ROOM_BOUNDS.nick.min).max(ROOM_BOUNDS.nick.max),
  /** False while the player's connection is gone (the clock keeps running). */
  connected: z.boolean(),
});
export type RoomPlayer = z.infer<typeof RoomPlayerSchema>;

// ---------------------------------------------------------------------------------------------
// Review store (ADR-017): building blocks

/**
 * Hard bounds of the review-store messages. Frames of the four record-carrying types may be
 * larger than {@link MAX_MESSAGE_BYTES} (up to {@link MAX_LARGE_MESSAGE_BYTES}).
 */
export const REVIEW_BOUNDS = {
  /** `gameKey`: SHA-256 hex (see `reviewGameKey`). */
  gameKeyPattern: /^[0-9a-f]{64}$/,
  /** Reviews are stored for games of 2 … 1000 plies (same cap as rooms). */
  plies: { min: 2, max: 1_000 },
  /** One SAN move, e.g. `Nbd7`, `exd8=Q#`, `O-O-O+`. */
  sanPattern: /^(O-O(-O)?|[a-h](x[a-h])?([2-7]|[18]=[NBRQ])|[NBRQK][a-h]?[1-8]?x?[a-h][1-8])[+#]?$/,
  /** Search budget of a position result: `mt:<ms>` (movetime) or `d:<depth>`. */
  optsKeyPattern: /^(mt:[1-9]\d{2,5}|d:[1-9]\d?)$/,
  /** Positions per `review.positions.get` / `review.positions.put`. */
  positionsPerMessage: 64,
  /** Principal variation plies kept per position result. */
  pvMaxLength: 16,
  /** JSON size of one `StoredReviewRecord` (the server refuses larger ones with `too_large`). */
  recordMaxBytes: 1024 * 1024,
} as const;

/**
 * Frames carrying a review record or a batch of positions (`review.put`, `review.record`,
 * `review.positions.put`, `review.positions`) may be this large; every other type keeps
 * {@link MAX_MESSAGE_BYTES}. The server sets `maxPayload` to this value.
 */
export const MAX_LARGE_MESSAGE_BYTES = REVIEW_BOUNDS.recordMaxBytes + 128 * 1024;

/** Message types allowed to exceed {@link MAX_MESSAGE_BYTES}. */
export const LARGE_MESSAGE_TYPES: readonly string[] = [
  'review.put',
  'review.record',
  'review.positions.put',
  'review.positions',
];

export const GameKeySchema = z
  .string()
  .regex(REVIEW_BOUNDS.gameKeyPattern, 'gameKey must be 64 lowercase hex characters');

export const SanMoveSchema = z
  .string()
  .max(10)
  .regex(REVIEW_BOUNDS.sanPattern, 'move must be in SAN (e.g. Nf3, exd5, O-O, e8=Q+)');

/** SAN moves of a whole game (2 … 1000 plies). */
export const SanMovesSchema = z
  .array(SanMoveSchema)
  .min(REVIEW_BOUNDS.plies.min, `at least ${REVIEW_BOUNDS.plies.min} moves`)
  .max(REVIEW_BOUNDS.plies.max, `at most ${REVIEW_BOUNDS.plies.max} moves`);

export const OptsKeySchema = z
  .string()
  .regex(REVIEW_BOUNDS.optsKeyPattern, 'optsKey must be mt:<ms> or d:<depth>');

export const ReviewPresetSchema = z.enum(REVIEW_PRESETS);

/** Search budget of a stored review (same shape as the web's `ReviewOptions`). */
export const ReviewOptionsSchema = z.object({
  depth: range('depth', PROTOCOL_BOUNDS.depth).optional(),
  movetime: range('movetime', PROTOCOL_BOUNDS.movetimeMs).optional(),
});

/** Where a review ran (the web's `ReviewEngineInfo`). */
export const ReviewEngineInfoSchema = z.object({
  kind: z.enum(['server', 'browser']),
  name: z.string().min(1).max(64).optional(),
  threads: range('threads', PROTOCOL_BOUNDS.threads).optional(),
});

/**
 * Engine result of one position as the review keeps it (the web's `PositionResult`): White-POV
 * eval, best move and line in UCI, reached depth.
 */
export const PositionResultSchema = z.object({
  eval: ScoreSchema,
  bestMove: UciMoveSchema.optional(),
  pv: z.array(UciMoveSchema).max(REVIEW_BOUNDS.pvMaxLength).optional(),
  depth: range('depth', { min: 0, max: 1_000 }).optional(),
});

const winProb = (name: string) =>
  z.number().min(0, `${name} must be >= 0`).max(100, `${name} must be <= 100`);
const plyNumber = range('ply', { min: 1, max: REVIEW_BOUNDS.plies.max });
const moverSchema = z.enum(['white', 'black']);
const moveClassSchema = z.enum(MOVE_CLASSES as readonly [MoveClass, ...MoveClass[]]);

/** Mirrors `ReviewedMove` (review.ts). */
export const ReviewedMoveSchema = z.object({
  ply: plyNumber,
  san: SanMoveSchema.optional(),
  uci: UciMoveSchema,
  mover: moverSchema,
  evalBefore: ScoreSchema,
  evalAfter: ScoreSchema,
  bestMove: UciMoveSchema.optional(),
  winProbBefore: winProb('winProbBefore'),
  winProbAfter: winProb('winProbAfter'),
  winProbLoss: winProb('winProbLoss'),
  classification: moveClassSchema,
});

/** Mirrors `SideSummary` (review.ts). */
export const SideSummarySchema = z.object({
  accuracy: winProb('accuracy'),
  counts: z.record(moveClassSchema, nonNegativeInt('counts')),
});

/** Mirrors `ReviewSummary` (review.ts). */
export const ReviewSummarySchema = z.object({
  white: SideSummarySchema,
  black: SideSummarySchema,
  moves: z.array(ReviewedMoveSchema).max(REVIEW_BOUNDS.plies.max),
});

/**
 * Per-move details of a stored review (the web's `MoveDetail`): the engine's best line in SAN,
 * evals and a swing text. Display data, bounded so a record stays well under
 * {@link REVIEW_BOUNDS.recordMaxBytes}.
 */
export const StoredMoveDetailSchema = z.object({
  ply: plyNumber,
  mover: moverSchema,
  moveLabel: z.string().max(8),
  playedUci: UciMoveSchema,
  playedSan: SanMoveSchema,
  bestUci: UciMoveSchema.optional(),
  bestSan: SanMoveSchema.optional(),
  bestLine: z.array(UciMoveSchema).max(REVIEW_BOUNDS.pvMaxLength),
  bestLineSan: z.string().max(200),
  bestLineMoves: z.array(SanMoveSchema).max(REVIEW_BOUNDS.pvMaxLength),
  bestLineFen: FenSchema,
  fenBefore: FenSchema,
  fenAfter: FenSchema,
  evalBeforeWhite: ScoreSchema,
  evalAfterWhite: ScoreSchema,
  evalIfBest: ScoreSchema.optional(),
  swing: z.string().max(40),
  winProbLoss: winProb('winProbLoss'),
  classification: moveClassSchema,
  playedIsBest: z.boolean(),
});

/**
 * What a review consists of beyond the game itself: the record the web caches and the server
 * stores (gzip JSON). `version` is the web's `REVIEW_CACHE_VERSION`; a client ignores records of
 * another version.
 */
export const StoredReviewRecordSchema = z.object({
  version: range('version', { min: 1, max: 1_000 }),
  options: ReviewOptionsSchema,
  engine: ReviewEngineInfoSchema,
  summary: ReviewSummarySchema,
  /** Keyed by ply (1-based, as a string in JSON). */
  moveDetails: z.record(z.string().regex(/^[1-9]\d{0,3}$/, 'ply'), StoredMoveDetailSchema),
});

/** A stored review as the browser cache keeps it: the record plus the game and its preset. */
export const StoredReviewSchema = StoredReviewRecordSchema.extend({
  gameKey: GameKeySchema,
  startFen: FenSchema,
  /** SAN moves of the game (also used to rule out key collisions). */
  moves: SanMovesSchema,
  preset: ReviewPresetSchema,
  /** Epoch ms of the run. */
  createdAt: nonNegativeInt('createdAt'),
});

/** Why a `review.put` / `review.positions.put` was not stored. */
export const REVIEW_STORE_REASONS = [
  /** The connection has no valid access token (`capabilities.analysis` is false). */
  'unauthorized',
  /** The store is off or failed to open (`capabilities.reviewStore` is false). */
  'disabled',
  /** `gameKey` is not the key of `startFen` + `moves`. */
  'key_mismatch',
  /** `startFen` is not a position chess.js accepts or a move is illegal. */
  'illegal_game',
  /** The record is larger than `REVIEW_BOUNDS.recordMaxBytes`. */
  'too_large',
  /** A review with a stronger preset is stored already (the stored one is kept). */
  'superseded',
  /** The client address used its daily put allowance (`REVIEW_PUT_PER_IP_PER_DAY`). */
  'quota',
  /** The database refused the write. */
  'storage_error',
] as const;
export type ReviewStoreReason = (typeof REVIEW_STORE_REASONS)[number];

// ---------------------------------------------------------------------------------------------
// Client → server

/** Maximum length of `hello.token`. */
export const MAX_TOKEN_LENGTH = 256;

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int().min(1),
  client: z
    .object({
      name: z.string().min(1).max(64),
      version: z.string().max(32).optional(),
    })
    .optional(),
  /**
   * Shared access token (ADR-010). On a server with `ACCESS_TOKEN`, a missing or wrong token
   * gives a restricted `welcome` (`capabilities.analysis: false`, no engines): rooms work,
   * `analyze` is answered with `unauthorized` (ADR-013).
   */
  token: z.string().max(MAX_TOKEN_LENGTH).optional(),
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

// Rooms (ADR-013), client → server. All carry `roomId` so the server can check that the
// connection is in that room; a connection is a member of at most one room at a time (creating,
// joining or attaching another room leaves the current one).

/**
 * Creates a room with the sender as host. `clock: null` = no clock. The server answers
 * `room.seat` (room id, the player token for reconnects, the host's colour) and `room.state`.
 */
export const RoomCreateMessageSchema = z.object({
  type: z.literal('room.create'),
  nick: NickSchema,
  clock: RoomClockSettingSchema.nullable(),
  color: RoomColorChoiceSchema,
});

/**
 * Joins a room by link. With `nick` the sender takes the free seat (the game starts) or, when
 * both seats are taken, becomes a spectator; without `nick` the sender only ever spectates.
 * A player gets `room.seat` + `room.state`; a spectator gets `room.state` (`you: 'spectator'`).
 */
export const RoomJoinMessageSchema = z.object({
  type: z.literal('room.join'),
  roomId: RoomIdSchema,
  nick: NickSchema.optional(),
});

/**
 * Re-takes a seat with the `playerToken` from `room.seat` (reload, new tab, reconnect). A
 * connection that still holds that seat is demoted to spectator. Answer: `room.state`.
 */
export const RoomAttachMessageSchema = z.object({
  type: z.literal('room.attach'),
  roomId: RoomIdSchema,
  playerToken: PlayerTokenSchema,
});

/** Plays a move (promotion as 5th character). Clears a pending draw offer. */
export const RoomMoveMessageSchema = z.object({
  type: z.literal('room.move'),
  roomId: RoomIdSchema,
  uci: UciMoveSchema,
});

export const RoomResignMessageSchema = z.object({
  type: z.literal('room.resign'),
  roomId: RoomIdSchema,
});

/**
 * `offer` offers a draw (offering while the opponent's offer is pending accepts it); `accept`
 * needs a pending offer of the opponent; `decline` withdraws or declines any pending offer.
 */
export const RoomDrawMessageSchema = z.object({
  type: z.literal('room.draw'),
  roomId: RoomIdSchema,
  action: z.enum(['offer', 'accept', 'decline']),
});

/** Cancels a waiting room (host) or a game before both sides have moved (either player). */
export const RoomAbortMessageSchema = z.object({
  type: z.literal('room.abort'),
  roomId: RoomIdSchema,
});

/**
 * Claims the game while the opponent has been disconnected for the grace period
 * (`room.state.claimableAt` has passed): a win if both sides had moved, otherwise an abort.
 */
export const RoomClaimMessageSchema = z.object({
  type: z.literal('room.claim'),
  roomId: RoomIdSchema,
});

/**
 * Detaches the connection from the room. A spectator is removed; a player is marked
 * disconnected (same as closing the socket) and can come back with `room.attach`.
 */
export const RoomLeaveMessageSchema = z.object({
  type: z.literal('room.leave'),
  roomId: RoomIdSchema,
});

// Review store (ADR-017), client → server. Reads are open to every connection, writes need a
// connection whose `hello` carried the valid access token (`capabilities.analysis`). Every request
// is answered with exactly one message carrying the same `gameKey` / `optsKey`.

/** Asks for the stored review of a game. Answer: `review.record` (`found: false` when none). */
export const ReviewGetMessageSchema = z.object({
  type: z.literal('review.get'),
  gameKey: GameKeySchema,
  startFen: FenSchema,
  moves: SanMovesSchema,
});

/**
 * Offers a finished review for storage. The server recomputes the key from `startFen` + `moves`
 * (replayed with chess.js), keeps the stronger preset and answers `review.stored`.
 */
export const ReviewPutMessageSchema = z.object({
  type: z.literal('review.put'),
  gameKey: GameKeySchema,
  startFen: FenSchema,
  moves: SanMovesSchema,
  preset: ReviewPresetSchema,
  record: StoredReviewRecordSchema,
});

/** Asks for stored position results of one search budget. Answer: `review.positions`. */
export const ReviewPositionsGetMessageSchema = z.object({
  type: z.literal('review.positions.get'),
  optsKey: OptsKeySchema,
  fens: z.array(FenSchema).min(1).max(REVIEW_BOUNDS.positionsPerMessage),
});

/** Offers position results of one search budget. Answer: `review.positions.stored`. */
export const ReviewPositionsPutMessageSchema = z.object({
  type: z.literal('review.positions.put'),
  optsKey: OptsKeySchema,
  entries: z
    .array(z.object({ fen: FenSchema, result: PositionResultSchema }))
    .min(1)
    .max(REVIEW_BOUNDS.positionsPerMessage),
});

/** Asks for the store's size. Answer: `review.stats`. */
export const ReviewStatsGetMessageSchema = z.object({ type: z.literal('review.stats.get') });

export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  AnalyzeMessageSchema,
  StopMessageSchema,
  ReleaseMessageSchema,
  PingMessageSchema,
  RoomCreateMessageSchema,
  RoomJoinMessageSchema,
  RoomAttachMessageSchema,
  RoomMoveMessageSchema,
  RoomResignMessageSchema,
  RoomDrawMessageSchema,
  RoomAbortMessageSchema,
  RoomClaimMessageSchema,
  RoomLeaveMessageSchema,
  ReviewGetMessageSchema,
  ReviewPutMessageSchema,
  ReviewPositionsGetMessageSchema,
  ReviewPositionsPutMessageSchema,
  ReviewStatsGetMessageSchema,
]);

export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type AnalyzeMessage = z.infer<typeof AnalyzeMessageSchema>;
export type StopMessage = z.infer<typeof StopMessageSchema>;
export type ReleaseMessage = z.infer<typeof ReleaseMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type RoomCreateMessage = z.infer<typeof RoomCreateMessageSchema>;
export type RoomJoinMessage = z.infer<typeof RoomJoinMessageSchema>;
export type RoomAttachMessage = z.infer<typeof RoomAttachMessageSchema>;
export type RoomMoveMessage = z.infer<typeof RoomMoveMessageSchema>;
export type RoomResignMessage = z.infer<typeof RoomResignMessageSchema>;
export type RoomDrawMessage = z.infer<typeof RoomDrawMessageSchema>;
export type RoomAbortMessage = z.infer<typeof RoomAbortMessageSchema>;
export type RoomClaimMessage = z.infer<typeof RoomClaimMessageSchema>;
export type RoomLeaveMessage = z.infer<typeof RoomLeaveMessageSchema>;
export type ReviewGetMessage = z.infer<typeof ReviewGetMessageSchema>;
export type ReviewPutMessage = z.infer<typeof ReviewPutMessageSchema>;
export type ReviewPositionsGetMessage = z.infer<typeof ReviewPositionsGetMessageSchema>;
export type ReviewPositionsPutMessage = z.infer<typeof ReviewPositionsPutMessageSchema>;
export type ReviewStatsGetMessage = z.infer<typeof ReviewStatsGetMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
/** Every `room.*` client message. */
export type RoomClientMessage = Extract<
  ClientMessage,
  { roomId: string } | { type: 'room.create' }
>;
/** Every `review.*` client message. */
export type ReviewClientMessage =
  | ReviewGetMessage
  | ReviewPutMessage
  | ReviewPositionsGetMessage
  | ReviewPositionsPutMessage
  | ReviewStatsGetMessage;
/** Shapes of the stored review and its parts (ADR-017). */
export type ReviewOptions = z.infer<typeof ReviewOptionsSchema>;
export type ReviewEngineInfo = z.infer<typeof ReviewEngineInfoSchema>;
export type PositionResult = z.infer<typeof PositionResultSchema>;
export type StoredMoveDetail = z.infer<typeof StoredMoveDetailSchema>;
export type StoredReviewRecord = z.infer<typeof StoredReviewRecordSchema>;
export type StoredReview = z.infer<typeof StoredReviewSchema>;

// ---------------------------------------------------------------------------------------------
// Server → client

/**
 * What this connection may do (ADR-013). Omitted by servers older than ADR-013, which means
 * `{ analysis: true, rooms: false }`. `analysis: false` (token missing/wrong on a server with
 * `ACCESS_TOKEN`) comes with an empty `engines` list; `analyze` then fails with `unauthorized`.
 * `reviewStore` (ADR-017; absent = false): the server stores reviews (`review.*` messages);
 * `review.put` additionally needs `analysis`.
 */
export const CapabilitiesSchema = z.object({
  analysis: z.boolean(),
  rooms: z.boolean(),
  reviewStore: z.boolean().optional(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const WelcomeMessageSchema = z.object({
  type: z.literal('welcome'),
  protocolVersion: z.number().int().min(1),
  serverVersion: z.string().max(64),
  limits: LimitsSchema,
  engines: z.array(EngineDescriptorSchema).max(64),
  capabilities: CapabilitiesSchema.optional(),
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

// Rooms (ADR-013), server → client.

/** The sender took a seat (on `room.create` and on `room.join` with a free seat). */
export const RoomSeatMessageSchema = z.object({
  type: z.literal('room.seat'),
  roomId: RoomIdSchema,
  /** Secret for `room.attach`; keep it in localStorage under the room id, never in the URL. */
  playerToken: PlayerTokenSchema,
  color: RoomSideSchema,
});

/**
 * Full snapshot of a room, sent to every member after every change (and to a member right after
 * it joins/attaches). Clients replace their state with it; nothing is sent incrementally.
 *
 * Displayed time of `clock.running` = `clock[running] - (now - receivedAt)`, where `receivedAt`
 * is the client's own clock at arrival (skew-free); `serverTime` (epoch ms) orders snapshots and
 * turns `claimableAt` into a countdown (`claimableAt - serverTime`).
 */
export const RoomStateMessageSchema = z.object({
  type: z.literal('room.state'),
  roomId: RoomIdSchema,
  status: z.enum(ROOM_STATUSES),
  players: z.object({ white: RoomPlayerSchema.optional(), black: RoomPlayerSchema.optional() }),
  /** The receiver's role in this room. */
  you: z.enum(['white', 'black', 'spectator']),
  spectators: nonNegativeInt('spectators'),
  /** Always the standard start position in protocol 1. */
  startFen: FenSchema,
  /** Position after `moves` (convenience; the client can also replay `moves`). */
  fen: FenSchema,
  moves: z.array(UciMoveSchema).max(ROOM_BOUNDS.maxPlies),
  clock: RoomClockStateSchema.nullable(),
  /** The side whose draw offer is pending. */
  drawOffer: RoomSideSchema.optional(),
  /**
   * While exactly one player is disconnected in a running game: epoch ms from which the other
   * player may `room.claim`. The server sends a fresh snapshot when it passes.
   */
  claimableAt: z.number().optional(),
  /** Absent in a finished room means no result (abort / abandoned before both moved). */
  result: z.enum(ROOM_RESULTS).optional(),
  reason: z.enum(ROOM_END_REASONS).optional(),
  /** Server wall clock (epoch ms) at which `clock` and `claimableAt` were computed. */
  serverTime: z.number(),
});

/** A `room.*` request failed; the room (if any) is unchanged. */
export const RoomErrorMessageSchema = z.object({
  type: z.literal('room.error'),
  roomId: RoomIdSchema.optional(),
  code: z.enum(ROOM_ERROR_CODES),
  message: z.string().max(1_000),
});

// Review store (ADR-017), server → client.

/**
 * Answer to `review.get`. `found: false` when nothing is stored for the key (or the stored game
 * differs from the requested one, or the store is disabled). `record.engine` says where it ran.
 */
export const ReviewRecordMessageSchema = z.object({
  type: z.literal('review.record'),
  gameKey: GameKeySchema,
  found: z.boolean(),
  preset: ReviewPresetSchema.optional(),
  record: StoredReviewRecordSchema.optional(),
  /** Epoch ms of the stored run. */
  createdAt: nonNegativeInt('createdAt').optional(),
});

/** Answer to `review.put`. */
export const ReviewStoredMessageSchema = z.object({
  type: z.literal('review.stored'),
  gameKey: GameKeySchema,
  stored: z.boolean(),
  reason: z.enum(REVIEW_STORE_REASONS).optional(),
});

/** Answer to `review.positions.get`: the results found, by FEN (missing FENs are absent). */
export const ReviewPositionsMessageSchema = z.object({
  type: z.literal('review.positions'),
  optsKey: OptsKeySchema,
  results: z.record(FenSchema, PositionResultSchema),
});

/** Answer to `review.positions.put`. */
export const ReviewPositionsStoredMessageSchema = z.object({
  type: z.literal('review.positions.stored'),
  optsKey: OptsKeySchema,
  stored: z.boolean(),
  reason: z.enum(REVIEW_STORE_REASONS).optional(),
});

/** Answer to `review.stats.get` (all zero when the store is disabled). */
export const ReviewStatsMessageSchema = z.object({
  type: z.literal('review.stats'),
  enabled: z.boolean(),
  reviews: nonNegativeInt('reviews'),
  positions: nonNegativeInt('positions'),
  bytes: nonNegativeInt('bytes'),
  maxBytes: nonNegativeInt('maxBytes'),
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  WelcomeMessageSchema,
  InfoMessageSchema,
  BestMoveMessageSchema,
  ErrorMessageSchema,
  PongMessageSchema,
  RoomSeatMessageSchema,
  RoomStateMessageSchema,
  RoomErrorMessageSchema,
  ReviewRecordMessageSchema,
  ReviewStoredMessageSchema,
  ReviewPositionsMessageSchema,
  ReviewPositionsStoredMessageSchema,
  ReviewStatsMessageSchema,
]);

export type EngineDescriptor = z.infer<typeof EngineDescriptorSchema>;
export type WelcomeMessage = z.infer<typeof WelcomeMessageSchema>;
export type InfoMessage = z.infer<typeof InfoMessageSchema>;
export type BestMoveMessage = z.infer<typeof BestMoveMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
export type RoomSeatMessage = z.infer<typeof RoomSeatMessageSchema>;
export type RoomStateMessage = z.infer<typeof RoomStateMessageSchema>;
export type RoomErrorMessage = z.infer<typeof RoomErrorMessageSchema>;
export type ReviewRecordMessage = z.infer<typeof ReviewRecordMessageSchema>;
export type ReviewStoredMessage = z.infer<typeof ReviewStoredMessageSchema>;
export type ReviewPositionsMessage = z.infer<typeof ReviewPositionsMessageSchema>;
export type ReviewPositionsStoredMessage = z.infer<typeof ReviewPositionsStoredMessageSchema>;
export type ReviewStatsMessage = z.infer<typeof ReviewStatsMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// Compile-time guarantee that the wire types stay interchangeable with the engine types.
type Assignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const infoMatchesEngineInfo: Assignable<z.infer<typeof EngineInfoSchema>, EngineInfo> = true;
const bestMoveMatchesBestMove: Assignable<z.infer<typeof BestMoveSchema>, BestMove> = true;
const summaryMatchesReviewSummary: Assignable<
  z.infer<typeof ReviewSummarySchema>,
  ReviewSummary
> = true;
void infoMatchesEngineInfo;
void bestMoveMatchesBestMove;
void summaryMatchesReviewSummary;

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
  let large = false;
  if (typeof input === 'string') {
    if (input.length > MAX_LARGE_MESSAGE_BYTES)
      return { ok: false, error: `message exceeds ${MAX_LARGE_MESSAGE_BYTES} bytes` };
    large = input.length > MAX_MESSAGE_BYTES;
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
  // Only the record-carrying review frames may exceed the ordinary frame size.
  if (large && !LARGE_MESSAGE_TYPES.includes(type)) {
    return { ok: false, error: `message exceeds ${MAX_MESSAGE_BYTES} bytes` };
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
