import { Chess } from 'chess.js';
import { currentFen, type GameStore, type Orientation } from '../store/gameStore';
import type { PremoveMode } from '../store/settingsStore';

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** The part of the zustand game store API the queue uses. */
export interface PremoveGameApi {
  getState(): GameStore;
  subscribe(listener: (state: GameStore, prev: GameStore) => void): () => void;
}

export interface PremoveQueueOptions {
  game: PremoveGameApi;
  /** The user's colour while a game runs, null when premoves are not possible. */
  color(): Orientation | null;
  mode(): PremoveMode;
  /** Extra gate (e.g. the live game: no move of the user in flight). Default: always. */
  canPlay?(): boolean;
  /** The queue changed (for the UI). */
  onChange(premoves: readonly string[]): void;
}

/** Legal move `uci` in `fen`? (A premove to the last rank without a piece promotes to a queen.) */
export function isLegalUci(fen: string, uci: string): boolean {
  if (!UCI.test(uci)) return false;
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return false;
  }
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promo = uci[4];
  return chess
    .moves({ verbose: true })
    .some((m) => m.from === from && m.to === to && (!m.promotion || !promo || m.promotion === promo));
}

/**
 * Premoves for games against an opponent (live lichess games, the local engine game), kept
 * outside chessground so that the queue mode can hold several.
 *
 * - `none`: premoves are ignored. `single`: a new premove replaces the old one. `queue`: they
 *   are appended.
 * - Whenever the game store changes and it is the user's turn **at the tip** (a user browsing
 *   earlier moves keeps the queue until they return), the first premove is checked with chess.js:
 *   legal → played with `makeMove` (the game logic sends it like a board move); illegal → the
 *   whole queue is cleared. So an opponent move that makes the first premove illegal clears it.
 *   One premove per turn.
 * - The move is played in a microtask, not inside the store notification that announced the turn.
 */
export class PremoveQueue {
  private readonly o: PremoveQueueOptions;
  private queue: string[] = [];
  private unsubscribe: (() => void) | null = null;
  private scheduled = false;
  private disposed = false;

  constructor(o: PremoveQueueOptions) {
    this.o = o;
    this.unsubscribe = o.game.subscribe(() => this.schedule());
  }

  get list(): readonly string[] {
    return this.queue;
  }

  add(uci: string): void {
    if (this.disposed || !UCI.test(uci) || this.o.color() === null) return;
    const mode = this.o.mode();
    if (mode === 'none') return;
    this.set(mode === 'single' ? [uci] : [...this.queue, uci]);
    this.schedule();
  }

  clear(): void {
    if (this.queue.length) this.set([]);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.queue = [];
  }

  /** Plays or drops the first premove if it is the user's turn now (also called by the owner). */
  check(): void {
    if (this.disposed || this.queue.length === 0) return;
    const color = this.o.color();
    if (color === null || this.o.mode() === 'none') {
      this.clear();
      return;
    }
    const s = this.o.game.getState();
    if (s.ply !== s.moves.length) return;
    const fen = currentFen(s);
    if ((fen.split(' ')[1] === 'b' ? 'black' : 'white') !== color) return;
    if (this.o.canPlay && !this.o.canPlay()) return;
    const [first, ...rest] = this.queue;
    if (!first || !isLegalUci(fen, first)) {
      this.set([]);
      return;
    }
    this.set(rest);
    if (!s.makeMove(first.slice(0, 2), first.slice(2, 4), first[4] ?? 'q')) this.set([]);
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.check();
    });
  }

  private set(q: string[]): void {
    this.queue = q;
    this.o.onChange(q);
  }
}

/** Board arrows for queued premoves, numbered in playing order. */
export function premoveShapes(premoves: readonly string[]): { orig: string; dest: string; brush: string; label?: { text: string } }[] {
  return premoves.map((uci, i) => ({
    orig: uci.slice(0, 2),
    dest: uci.slice(2, 4),
    brush: 'paleGrey',
    ...(premoves.length > 1 ? { label: { text: String(i + 1) } } : {}),
  }));
}

/**
 * Display names for queued premoves: SAN as if the opponent passed in between (the premove is
 * played from the current position, pieces moved by earlier premoves included); `e2-e4` style
 * when that is not a legal move there.
 */
export function premoveLabels(fen: string, color: Orientation, premoves: readonly string[]): string[] {
  const side = color === 'white' ? 'w' : 'b';
  let cur = fen;
  return premoves.map((uci) => {
    const plain = `${uci.slice(0, 2)}-${uci.slice(2, 4)}`;
    const parts = cur.split(' ');
    parts[1] = side;
    parts[3] = '-';
    try {
      const chess = new Chess(parts.join(' '));
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? 'q' });
      cur = chess.fen();
      return m.san;
    } catch {
      return plain;
    }
  });
}
