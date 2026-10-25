import { Chess, type PieceSymbol } from 'chess.js';
import { START_FEN, type GameState, type GameStore, type MoveRecord, type Orientation } from '../store/gameStore';
import type { PremoveMode } from '../store/settingsStore';
import { PremoveQueue } from './premoves';
import {
  BoardApiError,
  isAbortError,
  type BoardApi,
  type GameFullEvent,
  type GameStateEvent,
  type GameStreamEvent,
  type LichessPlayer,
} from './boardApi';

/** lichess statuses of a game that is still on. Everything else ends it. */
const RUNNING = new Set(['created', 'started']);

export interface LiveOpponent {
  name: string;
  rating?: number;
  title?: string;
  aiLevel?: number;
}

/** Snapshot of the lichess game the user plays (what the Live panel renders). */
export interface LiveGame {
  id: string;
  color: Orientation;
  opponent: LiveOpponent;
  rated: boolean;
  /** ms; null for games without a clock (correspondence/unlimited). */
  clock: { initial: number; increment: number } | null;
  speed: string;
  /** lichess status: created, started, mate, resign, outoftime, draw, aborted, … */
  status: string;
  /** UCI moves confirmed by lichess. */
  moves: string[];
  /** Colour to move in the initial position (black only for FEN starts). */
  firstToMove: Orientation;
  /** Clock times (ms) at {@link lastStateAt}. */
  wtime: number;
  btime: number;
  /** Local timestamp (clock source) of the last game state. */
  lastStateAt: number;
  /** A pending draw offer. */
  drawOffer?: 'opponent' | 'mine';
  winner?: Orientation;
  /** The finishing status (mate, resign, …) once the game is over. */
  reason?: string;
  /** Set while the opponent has left the game; victory can be claimed from `claimAt` (clock source). */
  opponentGone?: { claimAt?: number };
}

export interface LiveGameControllerOptions {
  api: BoardApi;
  game: LiveGameStoreApi;
  gameId: string;
  /** The logged-in user (decides the colour from `gameFull`). */
  username?: string;
  /** Colour hint from `gameStart`/ongoing games (used when the players carry no id, e.g. AI). */
  colorHint?: Orientation;
  /** Clock source (ms). */
  now?: () => number;
  /** Waits between reconnects (tests make it instant). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onChange(game: LiveGame): void;
  /** The game is over (status not created/started). */
  onFinish(game: LiveGame): void;
  /** A user-facing error (rejected move, failed request, lost stream). */
  onError(message: string): void;
  /** Premove mode (settings); default `single`. */
  premoveMode?: () => PremoveMode;
  /** The premove queue changed (played, dropped, added). */
  onPremoves?(premoves: readonly string[]): void;
}

/** The part of the zustand game store API the controller uses. */
export interface LiveGameStoreApi {
  getState(): GameStore;
  setState(patch: Partial<GameState>): void;
  subscribe(listener: (state: GameStore, prev: GameStore) => void): () => void;
}

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 30_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 16));
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export const moveToUci = (m: Pick<MoveRecord, 'from' | 'to' | 'promotion'>): string =>
  `${m.from}${m.to}${m.promotion ?? ''}`;

const sideToMove = (fen: string): Orientation => (fen.split(' ')[1] === 'b' ? 'black' : 'white');

/** Colour to move after `plies` half-moves. */
export function toMove(g: Pick<LiveGame, 'firstToMove'>, plies: number): Orientation {
  const other: Orientation = g.firstToMove === 'white' ? 'black' : 'white';
  return plies % 2 === 0 ? g.firstToMove : other;
}

export const isRunning = (g: Pick<LiveGame, 'status'>): boolean => RUNNING.has(g.status);

/**
 * Remaining time (ms) of `side` at `now`. lichess starts the clocks after each side's first
 * move, so before that and after the game nothing ticks; afterwards only the side to move loses
 * time since the last game state.
 */
export function remainingMs(g: LiveGame, side: Orientation, now: number): number {
  const base = side === 'white' ? g.wtime : g.btime;
  if (!g.clock || !isRunning(g) || g.moves.length < 2) return Math.max(0, base);
  if (toMove(g, g.moves.length) !== side) return Math.max(0, base);
  return Math.max(0, base - Math.max(0, now - g.lastStateAt));
}

export { formatClock } from '../clock/format';

/** Replays UCI moves from `fen` into game store records; stops at the first illegal move. */
export function replay(fen: string, ucis: readonly string[]): { records: MoveRecord[]; ok: boolean } {
  const chess = new Chess(fen);
  const records: MoveRecord[] = [];
  for (const uci of ucis) {
    if (!UCI.test(uci)) return { records, ok: false };
    let r;
    try {
      r = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: (uci[4] as PieceSymbol | undefined) ?? undefined });
    } catch {
      return { records, ok: false };
    }
    records.push({
      san: r.san,
      from: r.from,
      to: r.to,
      fen: chess.fen(),
      ...(r.promotion ? { promotion: r.promotion } : {}),
    });
  }
  return { records, ok: true };
}

function opponentOf(p: LichessPlayer): LiveOpponent {
  const o: LiveOpponent = { name: p.name };
  if (p.rating !== undefined) o.rating = p.rating;
  if (p.title) o.title = p.title;
  if (p.aiLevel !== undefined) o.aiLevel = p.aiLevel;
  return o;
}

function pgnHeaders(full: GameFullEvent, startFen: string): Record<string, string> {
  const h: Record<string, string> = {
    Event: `${full.rated ? 'Rated' : 'Casual'} ${full.speed} game`,
    Site: `https://lichess.org/${full.id}`,
    White: full.white.name,
    Black: full.black.name,
  };
  if (full.white.rating !== undefined) h.WhiteElo = String(full.white.rating);
  if (full.black.rating !== undefined) h.BlackElo = String(full.black.rating);
  h.TimeControl = full.clock ? `${Math.round(full.clock.initial / 1000)}+${Math.round(full.clock.increment / 1000)}` : '-';
  if (startFen !== START_FEN) {
    h.SetUp = '1';
    h.FEN = startFen;
  }
  return h;
}

const errorText = (e: unknown): string =>
  e instanceof BoardApiError ? e.message : e instanceof Error ? e.message : 'Request to lichess failed';

/**
 * Plays one lichess game through the Board API and mirrors it into the game store.
 *
 * - **Streams:** reads `/api/board/game/stream/{id}` (`gameFull`, then `gameState` per move,
 *   `opponentGone`, `chatLine`); when the stream drops before the game is over it reconnects with
 *   exponential backoff ({@link reconnectDelay}); lichess resends `gameFull` with the full state.
 * - **Mirror:** lichess is the source of truth. The game store holds the lichess moves (plus the
 *   user's move while it is being sent). New moves are appended without moving the view when the
 *   user browses an earlier ply (no truncation); a store that diverged (New game, a loaded PGN, a
 *   move played on an earlier ply) is rebuilt from the lichess moves.
 * - **User moves:** the board plays the move into the store (only at the tip on the user's turn);
 *   the controller sees one extra move and sends it (optimistic). A rejected move (400) is rolled
 *   back. Premoves are kept here and played when it becomes the user's turn, if legal.
 * - **Finish:** a status other than created/started ends the game ({@link LiveGameControllerOptions.onFinish}).
 */
export class LiveGameController {
  private readonly o: LiveGameControllerOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly abort = new AbortController();
  private g: LiveGame | null = null;
  private startFen = START_FEN;
  private headers: Record<string, string> | null = null;
  /** Records for the confirmed lichess moves (cache: extended move by move). */
  private records: MoveRecord[] = [];
  /** The user's move sent to lichess but not yet in a game state. */
  private pending: { uci: string; record: MoveRecord } | null = null;
  private readonly premoves: PremoveQueue;
  private unsubscribe: (() => void) | null = null;
  /** True while the controller writes the game store itself. */
  private writing = false;
  private finished = false;
  private disposed = false;

  constructor(o: LiveGameControllerOptions) {
    this.o = o;
    this.now = o.now ?? (() => Date.now());
    this.sleep = o.sleep ?? defaultSleep;
    this.premoves = new PremoveQueue({
      game: o.game,
      color: () => (this.g && !this.finished && !this.disposed && isRunning(this.g) ? this.g.color : null),
      mode: o.premoveMode ?? (() => 'single'),
      // Only on a store that mirrors lichess exactly (no move of the user in flight).
      canPlay: () => this.isMyTurn() && this.o.game.getState().moves.length === this.records.length,
      onChange: (list) => this.o.onPremoves?.(list),
    });
  }

  get gameId(): string {
    return this.o.gameId;
  }

  get snapshot(): LiveGame | null {
    return this.g;
  }

  /** Opens the game stream (with reconnects) until the game is over or {@link dispose}. */
  start(): Promise<void> {
    this.unsubscribe ??= this.o.game.subscribe(() => this.onStoreChange());
    return this.run();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.premoves.dispose();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Adds a premove (UCI) to play when it becomes the user's turn (replaces it in `single` mode). */
  addPremove(uci: string): void {
    this.premoves.add(uci);
  }

  clearPremoves(): void {
    this.premoves.clear();
  }

  get premoveList(): readonly string[] {
    return this.premoves.list;
  }

  /** Plays `uci` for the user (programmatic path; the board goes through the store). */
  playMove(uci: string): boolean {
    const g = this.g;
    if (!g || !this.isMyTurn() || !UCI.test(uci)) return false;
    const s = this.o.game.getState();
    if (s.ply !== s.moves.length) return false;
    return s.makeMove(uci.slice(0, 2), uci.slice(2, 4), uci[4]);
  }

  /** True when the game runs, it is the user's turn and no move of the user is in flight. */
  isMyTurn(): boolean {
    const g = this.g;
    return !!g && isRunning(g) && !this.finished && !this.pending && toMove(g, g.moves.length) === g.color;
  }

  // --- stream --------------------------------------------------------------------------------

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.disposed && !this.finished) {
      try {
        for await (const ev of this.o.api.streamGame(this.o.gameId, this.abort.signal)) {
          attempt = 0;
          this.handle(ev);
          if (this.finished || this.disposed) break;
        }
      } catch (e) {
        if (this.disposed || isAbortError(e)) return;
        if (e instanceof BoardApiError && (e.kind === 'unauthorized' || e.kind === 'not_found' || e.kind === 'bad_request')) {
          this.o.onError(e.message);
          return;
        }
      }
      if (this.disposed || this.finished) return;
      await this.sleep(reconnectDelay(attempt++), this.abort.signal);
    }
  }

  /** Applies one stream event (public for tests driving the controller without a stream). */
  handle(ev: GameStreamEvent): void {
    if (this.disposed) return;
    switch (ev.type) {
      case 'gameFull':
        this.onFull(ev);
        break;
      case 'gameState':
        this.onState(ev);
        break;
      case 'opponentGone':
        if (!this.g) return;
        if (ev.gone) {
          const claimAt = ev.claimWinInSeconds !== undefined ? this.now() + ev.claimWinInSeconds * 1000 : undefined;
          this.g = { ...this.g, opponentGone: claimAt !== undefined ? { claimAt } : {} };
        } else {
          const { opponentGone: _, ...rest } = this.g;
          void _;
          this.g = rest;
        }
        this.o.onChange(this.g);
        break;
      case 'chatLine':
        break;
    }
  }

  private onFull(full: GameFullEvent): void {
    const startFen = full.initialFen === 'startpos' ? START_FEN : full.initialFen;
    let color: Orientation | undefined;
    const me = this.o.username?.toLowerCase();
    if (me && full.white.id === me) color = 'white';
    else if (me && full.black.id === me) color = 'black';
    else color = this.o.colorHint ?? (full.black.aiLevel !== undefined ? 'white' : full.white.aiLevel !== undefined ? 'black' : 'white');
    const opp = color === 'white' ? full.black : full.white;
    const first = this.g === null || this.g.id !== full.id;
    this.startFen = startFen;
    this.g = {
      id: full.id,
      color,
      opponent: opponentOf(opp),
      rated: full.rated,
      clock: full.clock,
      speed: full.speed,
      status: 'started',
      moves: this.g?.moves ?? [],
      firstToMove: sideToMove(startFen),
      wtime: full.state.wtime,
      btime: full.state.btime,
      lastStateAt: this.now(),
      ...(this.g?.opponentGone ? { opponentGone: this.g.opponentGone } : {}),
    };
    if (first) {
      this.records = [];
      this.headers = pgnHeaders(full, startFen);
      this.writeStore({ ply: 'tip', headers: this.headers, orientation: color });
    }
    this.onState(full.state);
  }

  private onState(st: GameStateEvent): void {
    const g = this.g;
    if (!g) return;
    const moves = st.moves.trim() ? st.moves.trim().split(/\s+/) : [];
    // Extend the record cache (or rebuild it when lichess sent a different line, e.g. a takeback).
    let k = 0;
    while (k < this.records.length && k < moves.length && moveToUci(this.records[k]!) === moves[k]) k++;
    if (k < this.records.length) this.records = this.records.slice(0, k);
    if (moves.length > k) {
      const from = k === 0 ? this.startFen : this.records[k - 1]!.fen;
      const r = replay(from, moves.slice(k));
      this.records = [...this.records, ...r.records];
      if (!r.ok) this.o.onError('lichess sent a move DaisyChess cannot replay');
    }
    const confirmed = this.records.map(moveToUci);
    if (this.pending && confirmed.length > g.moves.length) {
      // The game advanced: our move is either confirmed or superseded.
      this.pending = null;
    }
    const mine = toMove(g, confirmed.length) === g.color;
    let drawOffer: LiveGame['drawOffer'];
    const oppOffers = g.color === 'white' ? st.bdraw : st.wdraw;
    const iOffer = g.color === 'white' ? st.wdraw : st.bdraw;
    if (oppOffers) drawOffer = 'opponent';
    else if (iOffer) drawOffer = 'mine';
    const next: LiveGame = {
      ...g,
      moves: confirmed,
      wtime: st.wtime,
      btime: st.btime,
      lastStateAt: this.now(),
      status: st.status,
    };
    delete next.drawOffer;
    if (drawOffer) next.drawOffer = drawOffer;
    if (st.winner) next.winner = st.winner;
    const over = !RUNNING.has(st.status);
    if (over) {
      next.reason = st.status;
      delete next.opponentGone;
      this.pending = null;
    }
    this.g = next;
    this.sync();
    this.o.onChange(next);
    if (over) {
      this.finished = true;
      this.premoves.clear();
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.o.onFinish(next);
      return;
    }
    if (mine) this.premoves.check();
  }

  // --- mirror --------------------------------------------------------------------------------

  private target(): MoveRecord[] {
    return this.pending ? [...this.records, this.pending.record] : this.records;
  }

  /** Writes the target moves into the store. `ply: 'tip'` follows the tip; 'keep' keeps an earlier view. */
  private writeStore(opts: { ply: 'tip' | 'keep'; headers?: Record<string, string>; orientation?: Orientation }): void {
    const s = this.o.game.getState();
    const moves = this.target();
    const atTip = s.ply >= s.moves.length;
    const ply = opts.ply === 'tip' || atTip ? moves.length : Math.min(s.ply, moves.length);
    const patch: Partial<GameState> = { moves, ply };
    if (s.startFen !== this.startFen) patch.startFen = this.startFen;
    if (opts.headers) patch.headers = opts.headers;
    else if (this.headers && s.headers !== this.headers) patch.headers = this.headers;
    if (opts.orientation) patch.orientation = opts.orientation;
    this.writing = true;
    try {
      this.o.game.setState(patch);
    } finally {
      this.writing = false;
    }
  }

  /** Brings the store in line with the lichess game (append, or rebuild if it diverged). */
  private sync(): void {
    if (!this.g) return;
    const s = this.o.game.getState();
    const target = this.target();
    const foreign = s.headers !== this.headers || s.startFen !== this.startFen;
    if (foreign) {
      this.writeStore({ ply: 'tip' });
      return;
    }
    let k = 0;
    while (k < s.moves.length && k < target.length && moveToUci(s.moves[k]!) === moveToUci(target[k]!)) k++;
    if (k === s.moves.length && k === target.length) return;
    if (k === s.moves.length) {
      this.writeStore({ ply: 'keep' });
      return;
    }
    // The store has moves lichess does not know: one new move at the tip on the user's turn is
    // the user's move; anything else (a move on an earlier ply, an edit) is rolled back.
    if (k === target.length && s.moves.length === target.length + 1 && s.ply === s.moves.length && this.isMyTurn()) {
      this.sendMove(s.moves[k]!);
      return;
    }
    this.writeStore({ ply: 'tip' });
  }

  private onStoreChange(): void {
    if (this.writing || this.disposed || this.finished || !this.g) return;
    this.sync();
  }

  private sendMove(record: MoveRecord): void {
    const g = this.g;
    if (!g) return;
    const uci = moveToUci(record);
    this.pending = { uci, record };
    this.o.onChange(g);
    this.o.api.move(g.id, uci).catch((e: unknown) => {
      if (this.disposed || this.finished) return;
      if (this.pending?.uci !== uci) return;
      this.pending = null;
      this.premoves.clear();
      this.writeStore({ ply: 'tip' });
      if (this.g) this.o.onChange(this.g);
      this.o.onError(e instanceof BoardApiError && e.kind === 'bad_request' ? `Move rejected by lichess: ${e.message}` : errorText(e));
    });
  }
}
