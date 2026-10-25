import { Chess } from 'chess.js';
import {
  ROOM_BOUNDS,
  type RoomClockSetting,
  type RoomColorChoice,
  type RoomEndReason,
  type RoomErrorCode,
  type RoomResult,
  type RoomSide,
  type RoomStateMessage,
  type RoomStatus,
} from '@daisychess/engine-core';
import { tokenMatches } from '../ws/token.js';

/**
 * One "play a friend via link" room (ADR-013): the pure game state machine. No timers, no
 * sockets, no wall clock — every method takes `now` in **monotonic milliseconds** (the manager
 * passes `performance.now()`, tests pass whatever they like), so the rules are deterministic.
 *
 * Rules
 * - Standard start position; chess.js validates moves and detects mate, stalemate and the
 *   automatic draws (threefold, 50 moves, insufficient material). At {@link ROOM_BOUNDS.maxPlies}
 *   the game is adjudicated a draw.
 * - Clock (Fischer): the first two plies are untimed and get no increment (lichess); from the
 *   third ply the side to move is charged on move arrival, gets the increment, and the opponent's
 *   clock starts. Running out of time loses, unless the opponent cannot mate (then a draw).
 * - A disconnected player keeps their clock running. After `claimGraceMs` the opponent may
 *   claim (a win once both sides have moved, otherwise an abort). Both gone that long → abandoned.
 */

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const otherSide = (s: RoomSide): RoomSide => (s === 'white' ? 'black' : 'white');

export interface RoomPlayerState {
  nick: string;
  /** Secret of this seat (`room.seat.playerToken`); compared in constant time. */
  readonly token: string;
  connected: boolean;
  /** Monotonic ms of the last disconnect; null while connected. */
  disconnectedAt: number | null;
}

interface ClockState {
  initialMs: number;
  incrementMs: number;
  /** Remaining ms as of `lastTickAt` (only `running`'s value changes between ticks). */
  white: number;
  black: number;
  running: RoomSide | null;
  lastTickAt: number;
}

export interface RoomOptions {
  id: string;
  /** Monotonic creation time. */
  now: number;
  host: { nick: string; token: string; color: RoomColorChoice };
  clock: RoomClockSetting | null;
  /** How long a player must be gone before the opponent may claim. */
  claimGraceMs: number;
  /** Random source for `color: 'random'` (tests inject). Default `Math.random`. */
  random?: () => number;
}

export type RoomActionResult =
  { ok: true; changed: boolean } | { ok: false; code: RoomErrorCode; message: string };

const ok = (changed = true): RoomActionResult => ({ ok: true, changed });
const fail = (code: RoomErrorCode, message: string): RoomActionResult => ({
  ok: false,
  code,
  message,
});

export class Room {
  readonly id: string;
  readonly hostColor: RoomSide;
  readonly claimGraceMs: number;
  readonly createdAt: number;
  status: RoomStatus = 'waiting';
  readonly players: { white: RoomPlayerState | null; black: RoomPlayerState | null } = {
    white: null,
    black: null,
  };
  readonly moves: string[] = [];
  drawOffer: RoomSide | null = null;
  result: RoomResult | null = null;
  reason: RoomEndReason | null = null;
  /** Monotonic time of the last move / join / finish (idle TTL). */
  lastActivityAt: number;
  /** Monotonic time the game ended; null while not finished. */
  finishedAt: number | null = null;
  private clock: ClockState | null;
  private readonly chess = new Chess();

  constructor(opts: RoomOptions) {
    this.id = opts.id;
    this.createdAt = opts.now;
    this.lastActivityAt = opts.now;
    this.claimGraceMs = opts.claimGraceMs;
    const random = opts.random ?? Math.random;
    this.hostColor =
      opts.host.color === 'random' ? (random() < 0.5 ? 'white' : 'black') : opts.host.color;
    this.players[this.hostColor] = {
      nick: opts.host.nick,
      token: opts.host.token,
      connected: true,
      disconnectedAt: null,
    };
    this.clock = opts.clock
      ? {
          initialMs: opts.clock.initialMs,
          incrementMs: opts.clock.incrementMs,
          white: opts.clock.initialMs,
          black: opts.clock.initialMs,
          running: null,
          lastTickAt: opts.now,
        }
      : null;
  }

  // -------------------------------------------------------------------------------------------
  // Seats

  /** The free seat of a waiting room, or null. */
  get freeSeat(): RoomSide | null {
    if (this.status !== 'waiting') return null;
    return this.players.white ? (this.players.black ? null : 'black') : 'white';
  }

  /** Takes the free seat; the game starts. */
  join(nick: string, token: string, now: number): RoomSide | null {
    const seat = this.freeSeat;
    if (!seat) return null;
    this.players[seat] = { nick, token, connected: true, disconnectedAt: null };
    this.status = 'playing';
    this.lastActivityAt = now;
    if (this.clock) this.clock.lastTickAt = now;
    return seat;
  }

  /** The seat `token` belongs to (constant-time comparison), or null. */
  sideOfToken(token: string): RoomSide | null {
    // Compare both seats unconditionally so timing does not reveal which seats exist.
    const w = this.players.white ? tokenMatches(token, this.players.white.token) : false;
    const b = this.players.black ? tokenMatches(token, this.players.black.token) : false;
    return w ? 'white' : b ? 'black' : null;
  }

  player(side: RoomSide): RoomPlayerState | null {
    return this.players[side];
  }

  /** Marks a player's connection state. */
  setConnected(side: RoomSide, connected: boolean, now: number): boolean {
    const p = this.players[side];
    if (!p || p.connected === connected) return false;
    p.connected = connected;
    p.disconnectedAt = connected ? null : now;
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Game actions (all return whether the public state changed)

  get sideToMove(): RoomSide {
    return this.chess.turn() === 'w' ? 'white' : 'black';
  }

  fen(): string {
    return this.chess.fen();
  }

  move(side: RoomSide, uci: string, now: number): RoomActionResult {
    this.tick(now);
    if (this.status !== 'playing') return fail('bad_state', 'the game is not running');
    if (this.sideToMove !== side) return fail('not_your_turn', 'it is not your turn');
    const promotion = uci[4];
    try {
      this.chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        ...(promotion ? { promotion } : {}),
      });
    } catch {
      return fail('illegal_move', `illegal move ${uci}`);
    }
    this.moves.push(uci);
    this.drawOffer = null;
    this.lastActivityAt = now;
    const c = this.clock;
    if (c) {
      if (c.running === side) {
        // tick(now) already charged `side`; Fischer increment, opponent's clock starts.
        c[side] += c.incrementMs;
        c.running = otherSide(side);
      } else if (c.running === null && this.moves.length >= 2) {
        c.running = otherSide(side);
      }
      c.lastTickAt = now;
    }
    if (this.chess.isCheckmate()) this.finish(now, 'checkmate', side === 'white' ? '1-0' : '0-1');
    else if (this.chess.isStalemate()) this.finish(now, 'stalemate', '1/2-1/2');
    else if (this.chess.isDraw() || this.moves.length >= ROOM_BOUNDS.maxPlies)
      this.finish(now, 'draw', '1/2-1/2');
    return ok();
  }

  resign(side: RoomSide, now: number): RoomActionResult {
    this.tick(now);
    if (this.status !== 'playing') return fail('bad_state', 'the game is not running');
    this.finish(now, 'resign', side === 'white' ? '0-1' : '1-0');
    return ok();
  }

  draw(side: RoomSide, action: 'offer' | 'accept' | 'decline', now: number): RoomActionResult {
    this.tick(now);
    if (this.status !== 'playing') return fail('bad_state', 'the game is not running');
    switch (action) {
      case 'offer':
        if (this.drawOffer === side) return ok(false);
        if (this.drawOffer === otherSide(side)) {
          this.finish(now, 'agreement', '1/2-1/2');
          return ok();
        }
        this.drawOffer = side;
        return ok();
      case 'accept':
        if (this.drawOffer !== otherSide(side)) return fail('bad_state', 'no draw offer to accept');
        this.finish(now, 'agreement', '1/2-1/2');
        return ok();
      case 'decline':
        if (this.drawOffer === null) return ok(false);
        this.drawOffer = null;
        return ok();
    }
  }

  /** Cancels a waiting room or a game before both sides have moved. */
  abort(now: number): RoomActionResult {
    this.tick(now);
    if (this.status === 'finished') return fail('bad_state', 'the game is over');
    if (this.status === 'playing' && this.moves.length >= 2)
      return fail('bad_state', 'the game can no longer be aborted; resign instead');
    this.finish(now, 'abort', null);
    return ok();
  }

  /** Monotonic time from which `side` may claim, or null when the opponent is present. */
  claimableAt(side: RoomSide): number | null {
    if (this.status !== 'playing') return null;
    const opp = this.players[otherSide(side)];
    if (!opp || opp.connected || opp.disconnectedAt === null) return null;
    return opp.disconnectedAt + this.claimGraceMs;
  }

  claim(side: RoomSide, now: number): RoomActionResult {
    this.tick(now);
    if (this.status !== 'playing') return fail('bad_state', 'the game is not running');
    const at = this.claimableAt(side);
    if (at === null) return fail('bad_state', 'your opponent is connected');
    if (now < at) return fail('bad_state', `you can claim in ${Math.ceil((at - now) / 1000)} s`);
    this.finish(
      now,
      'abandoned',
      this.moves.length >= 2 ? (side === 'white' ? '1-0' : '0-1') : null,
    );
    return ok();
  }

  /** Ends the room from outside the rules (TTL expiry): abandoned without a result. */
  expire(now: number): boolean {
    if (this.status === 'finished') return false;
    this.finish(now, 'abandoned', null);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Time

  /**
   * Charges the running side and applies what is due at `now`: a flag (timeout) or both players
   * gone beyond the grace period (abandoned). Returns whether the public state changed.
   */
  tick(now: number): boolean {
    if (this.status !== 'playing') return false;
    const c = this.clock;
    if (c && c.running) {
      const side = c.running;
      c[side] = Math.max(0, c[side] - Math.max(0, now - c.lastTickAt));
      c.lastTickAt = now;
      if (c[side] === 0) {
        const winner = otherSide(side);
        const result = hasMatingMaterial(this.chess.fen(), winner)
          ? winner === 'white'
            ? '1-0'
            : '0-1'
          : '1/2-1/2';
        this.finish(now, 'timeout', result);
        return true;
      }
    }
    const w = this.players.white;
    const b = this.players.black;
    if (
      w &&
      b &&
      !w.connected &&
      !b.connected &&
      w.disconnectedAt !== null &&
      b.disconnectedAt !== null &&
      Math.max(w.disconnectedAt, b.disconnectedAt) + this.claimGraceMs <= now
    ) {
      this.finish(now, 'abandoned', null);
      return true;
    }
    return false;
  }

  /**
   * Monotonic time of the next event {@link tick} will act on (flag, both-gone abandonment) or
   * that changes what a snapshot says (`claimableAt` passing); null when nothing is pending.
   */
  nextDeadline(): number | null {
    if (this.status !== 'playing') return null;
    const candidates: number[] = [];
    const c = this.clock;
    if (c && c.running) candidates.push(c.lastTickAt + c[c.running]);
    const gone = (['white', 'black'] as const)
      .map((s) => this.players[s])
      .filter((p): p is RoomPlayerState => p !== null && !p.connected && p.disconnectedAt !== null);
    if (gone.length > 0) {
      candidates.push(Math.max(...gone.map((p) => p.disconnectedAt!)) + this.claimGraceMs);
    }
    return candidates.length ? Math.min(...candidates) : null;
  }

  /** Remaining ms of `side` at `now` without changing the clock; null without a clock. */
  remaining(side: RoomSide, now: number): number | null {
    const c = this.clock;
    if (!c) return null;
    if (c.running !== side || this.status !== 'playing') return c[side];
    return Math.max(0, c[side] - Math.max(0, now - c.lastTickAt));
  }

  // -------------------------------------------------------------------------------------------
  // Snapshot

  /**
   * The `room.state` message for a member with role `you`. `now` is monotonic (for the clock),
   * `serverTime` the wall clock (epoch ms) the client sees; `claimableAt` is converted between
   * the two.
   */
  snapshot(
    you: RoomSide | 'spectator',
    spectators: number,
    now: number,
    serverTime: number,
  ): RoomStateMessage {
    const c = this.clock;
    const msg: RoomStateMessage = {
      type: 'room.state',
      roomId: this.id,
      status: this.status,
      players: {},
      you,
      spectators,
      startFen: START_FEN,
      fen: this.chess.fen(),
      moves: [...this.moves],
      clock: c
        ? {
            initialMs: c.initialMs,
            incrementMs: c.incrementMs,
            white: Math.round(this.remaining('white', now) ?? 0),
            black: Math.round(this.remaining('black', now) ?? 0),
            running: this.status === 'playing' ? c.running : null,
          }
        : null,
      serverTime,
    };
    for (const side of ['white', 'black'] as const) {
      const p = this.players[side];
      if (p) msg.players[side] = { nick: p.nick, connected: p.connected };
    }
    if (this.drawOffer) msg.drawOffer = this.drawOffer;
    if (this.result) msg.result = this.result;
    if (this.reason) msg.reason = this.reason;
    if (this.status === 'playing') {
      const w = this.players.white;
      const b = this.players.black;
      // Exactly one player gone: the other may claim from `claimableAt`.
      if (w && b && w.connected !== b.connected) {
        const at = this.claimableAt(w.connected ? 'white' : 'black');
        if (at !== null) msg.claimableAt = Math.round(serverTime + (at - now));
      }
    }
    return msg;
  }

  // -------------------------------------------------------------------------------------------

  private finish(now: number, reason: RoomEndReason, result: RoomResult | null): void {
    this.status = 'finished';
    this.reason = reason;
    this.result = result;
    this.drawOffer = null;
    this.finishedAt = now;
    this.lastActivityAt = now;
    if (this.clock) {
      this.clock.running = null;
      this.clock.lastTickAt = now;
    }
  }
}

/**
 * Whether `side` could still deliver mate by any sequence of legal moves (FIDE 6.9 / lichess
 * flag rule): false with a bare king, king + one knight, or king + bishops on one square colour.
 * The flagging side loses only if the opponent has mating material; otherwise it is a draw.
 */
export function hasMatingMaterial(fen: string, side: RoomSide): boolean {
  const color = side === 'white' ? 'w' : 'b';
  let knights = 0;
  const bishopColors = new Set<number>();
  for (const [r, rank] of new Chess(fen).board().entries()) {
    for (const [f, sq] of rank.entries()) {
      if (!sq || sq.color !== color || sq.type === 'k') continue;
      if (sq.type === 'n') knights++;
      else if (sq.type === 'b') bishopColors.add((r + f) % 2);
      else return true; // pawn, rook or queen
    }
  }
  if (knights === 0) return bishopColors.size >= 2;
  return knights >= 2 || bishopColors.size > 0;
}
