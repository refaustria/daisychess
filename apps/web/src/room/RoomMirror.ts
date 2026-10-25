import type { RoomSide, RoomStateMessage } from '@daisychess/engine-core';
import { moveToUci, replay, type LiveGameStoreApi } from '../live/LiveGameController';
import { PremoveQueue } from '../live/premoves';
import { START_FEN, type GameState, type MoveRecord, type Orientation } from '../store/gameStore';
import type { PremoveMode } from '../store/settingsStore';

export interface RoomMirrorOptions {
  game: LiveGameStoreApi;
  /** Sends `room.move`; false when it could not be sent (offline). */
  sendMove(uci: string): boolean;
  premoveMode(): PremoveMode;
  onPremoves(list: readonly string[]): void;
  /** A user-facing error (move not sent). */
  onError(message: string): void;
}

const timeControl = (c: RoomStateMessage['clock']): string =>
  c ? `${Math.round(c.initialMs / 1000)}+${Math.round(c.incrementMs / 1000)}` : '-';

/** Side to move after `plies` half-moves from the standard start (rooms always use it). */
export const sideToMoveAt = (plies: number): RoomSide => (plies % 2 === 0 ? 'white' : 'black');

/** PGN headers of a room game (stable object per players/clock, so loads are detectable). */
export function roomHeaders(s: Pick<RoomStateMessage, 'players' | 'clock'>): Record<string, string> {
  return {
    Event: 'Friend game',
    Site: 'DaisyChess',
    White: s.players.white?.nick ?? '?',
    Black: s.players.black?.nick ?? '?',
    TimeControl: timeControl(s.clock),
  };
}

const headersKey = (h: Record<string, string>): string => JSON.stringify(h);

/**
 * Mirrors a room's `room.state` snapshots into the game store (the server is authoritative,
 * like `LiveGameController` mirrors lichess):
 *
 * - The store holds the room's moves (replayed with chess.js) plus the user's move while it is
 *   on its way. New moves are appended without moving the view when the user browses an earlier
 *   ply; a store that diverged (New game, a loaded PGN, a move on an earlier ply) is rebuilt.
 * - A move the user plays at the tip on their turn is sent as `room.move` (optimistic); a
 *   rejection ({@link rejectMove}) rolls it back. Premoves are played when it becomes the user's
 *   turn and they are still legal (settings `premoves`).
 * - Once the game is finished the final moves are written once and the store is left alone (the
 *   user may analyse freely); later snapshots of the same room do not touch it.
 */
export class RoomMirror {
  private readonly o: RoomMirrorOptions;
  private snap: RoomStateMessage | null = null;
  private records: MoveRecord[] = [];
  private headers: Record<string, string> | null = null;
  private pending: { uci: string; record: MoveRecord } | null = null;
  private readonly premoves: PremoveQueue;
  private unsubscribe: (() => void) | null = null;
  private writing = false;
  /** The final position was written; snapshots no longer touch the store. */
  private settled = false;
  private disposed = false;

  constructor(o: RoomMirrorOptions) {
    this.o = o;
    this.premoves = new PremoveQueue({
      game: o.game,
      color: () => this.myColor(),
      mode: o.premoveMode,
      canPlay: () => this.isMyTurn() && this.o.game.getState().moves.length === this.records.length,
      onChange: (list) => this.o.onPremoves(list),
    });
    this.unsubscribe = o.game.subscribe(() => this.onStoreChange());
  }

  get roomId(): string | undefined {
    return this.snap?.roomId;
  }

  /** The move sent but not yet confirmed (UCI). */
  get pendingMove(): string | undefined {
    return this.pending?.uci;
  }

  get premoveList(): readonly string[] {
    return this.premoves.list;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.premoves.dispose();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  addPremove(uci: string): void {
    this.premoves.add(uci);
  }

  clearPremoves(): void {
    this.premoves.clear();
  }

  /** The user's colour while the game runs (null for spectators and outside `playing`). */
  myColor(): Orientation | null {
    const s = this.snap;
    if (!s || this.disposed || s.status !== 'playing' || s.you === 'spectator') return null;
    return s.you;
  }

  /** The game runs, it is the user's turn and no move of the user is in flight. */
  isMyTurn(): boolean {
    const color = this.myColor();
    return color !== null && !this.pending && sideToMoveAt(this.snap!.moves.length) === color;
  }

  /** Applies a snapshot of the room (the caller filters other rooms and stale snapshots). */
  apply(s: RoomStateMessage): void {
    if (this.disposed) return;
    const prev = this.snap;
    const newRoom = !prev || prev.roomId !== s.roomId;
    if (newRoom) {
      this.records = [];
      this.pending = null;
      this.settled = false;
      this.headers = null;
      this.premoves.clear();
    }
    if (this.settled) {
      this.snap = s;
      return;
    }
    // Extend the record cache (rebuild when the server's line differs, which it never should).
    let k = 0;
    while (k < this.records.length && k < s.moves.length && moveToUci(this.records[k]!) === s.moves[k]) k++;
    if (k < this.records.length) this.records = this.records.slice(0, k);
    if (s.moves.length > k) {
      const from = k === 0 ? START_FEN : this.records[k - 1]!.fen;
      const r = replay(from, s.moves.slice(k));
      this.records = [...this.records, ...r.records];
      if (!r.ok) this.o.onError('The server sent a move DaisyChess cannot replay');
    }
    if (this.pending && (s.moves.length > (prev?.moves.length ?? 0) || s.status !== 'playing')) {
      // The game advanced (our move confirmed or superseded) or ended.
      this.pending = null;
    }
    this.snap = s;

    const headers = roomHeaders(s);
    const orientation: Orientation = s.you === 'spectator' ? 'white' : s.you;
    const turnOrientation = newRoom || prev?.you !== s.you;
    if (!this.headers || headersKey(this.headers) !== headersKey(headers)) {
      // A new game in the store: first the empty game with the headers (never looks like a
      // loaded game to the auto review), then the moves.
      this.headers = headers;
      this.write({ moves: [], ply: 0, startFen: START_FEN, headers, ...(turnOrientation ? { orientation } : {}) });
      this.writeStore('tip');
    } else {
      if (turnOrientation) this.write({ orientation });
      this.sync();
    }

    if (s.status === 'finished') {
      this.settled = true;
      this.premoves.clear();
      return;
    }
    if (this.isMyTurn()) this.premoves.check();
  }

  /** The server rejected the user's move (`illegal_move`, `not_your_turn`): roll it back. */
  rejectMove(): void {
    if (!this.pending) return;
    this.pending = null;
    this.premoves.clear();
    this.writeStore('tip');
  }

  // --- store ---------------------------------------------------------------------------------

  private target(): MoveRecord[] {
    return this.pending ? [...this.records, this.pending.record] : this.records;
  }

  private write(patch: Partial<GameState>): void {
    this.writing = true;
    try {
      this.o.game.setState(patch);
    } finally {
      this.writing = false;
    }
  }

  private writeStore(mode: 'tip' | 'keep'): void {
    const s = this.o.game.getState();
    const moves = this.target();
    const atTip = s.ply >= s.moves.length;
    const ply = mode === 'tip' || atTip ? moves.length : Math.min(s.ply, moves.length);
    const patch: Partial<GameState> = { moves, ply };
    if (s.startFen !== START_FEN) patch.startFen = START_FEN;
    if (this.headers && s.headers !== this.headers) patch.headers = this.headers;
    this.write(patch);
  }

  private sync(): void {
    if (!this.snap) return;
    const s = this.o.game.getState();
    const target = this.target();
    if (s.headers !== this.headers || s.startFen !== START_FEN) {
      this.writeStore('tip');
      return;
    }
    let k = 0;
    while (k < s.moves.length && k < target.length && moveToUci(s.moves[k]!) === moveToUci(target[k]!)) k++;
    if (k === s.moves.length && k === target.length) return;
    if (k === s.moves.length) {
      this.writeStore('keep');
      return;
    }
    // One new move at the tip on the user's turn is the user's move; anything else is undone.
    if (
      k === target.length &&
      s.moves.length === target.length + 1 &&
      s.ply === s.moves.length &&
      this.isMyTurn()
    ) {
      this.send(s.moves[k]!);
      return;
    }
    this.writeStore('tip');
  }

  private onStoreChange(): void {
    if (this.writing || this.disposed || this.settled || !this.snap) return;
    this.sync();
  }

  private send(record: MoveRecord): void {
    const uci = moveToUci(record);
    this.pending = { uci, record };
    if (!this.o.sendMove(uci)) {
      this.pending = null;
      this.premoves.clear();
      this.writeStore('tip');
      this.o.onError('Not connected – the move was not sent');
    }
  }
}
