import { Chess, type PieceSymbol } from 'chess.js';
import { create } from 'zustand';

export interface MoveRecord {
  san: string;
  from: string;
  to: string;
  /** FEN after the move. */
  fen: string;
  promotion?: string;
}

export type Orientation = 'white' | 'black';
export type GameStatus = 'playing' | 'checkmate' | 'stalemate' | 'draw';

/** Plain, serialisable game state. chess.js instances are derived, never stored. */
export interface GameState {
  startFen: string;
  moves: MoveRecord[];
  /** 0 = start position, N = after N moves. */
  ply: number;
  orientation: Orientation;
  headers: Record<string, string>;
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const initialState = (): GameState => ({
  startFen: START_FEN,
  moves: [],
  ply: 0,
  orientation: 'white',
  headers: {},
});

export function currentFen(s: Pick<GameState, 'startFen' | 'moves' | 'ply'>): string {
  return s.ply === 0 ? s.startFen : (s.moves[s.ply - 1]?.fen ?? s.startFen);
}

const chessAt = (s: GameState): Chess => new Chess(currentFen(s));

export function turn(s: GameState): 'white' | 'black' {
  return currentFen(s).split(' ')[1] === 'b' ? 'black' : 'white';
}

export function legalDests(s: GameState): Map<string, string[]> {
  const dests = new Map<string, string[]>();
  for (const m of chessAt(s).moves({ verbose: true })) {
    const list = dests.get(m.from);
    if (list) list.push(m.to);
    else dests.set(m.from, [m.to]);
  }
  return dests;
}

export function lastMove(s: GameState): [string, string] | undefined {
  const m = s.ply > 0 ? s.moves[s.ply - 1] : undefined;
  return m ? [m.from, m.to] : undefined;
}

export function isCheck(s: GameState): boolean {
  return chessAt(s).isCheck();
}

export function gameStatus(s: GameState): GameStatus {
  const c = chessAt(s);
  if (c.isCheckmate()) return 'checkmate';
  if (c.isStalemate()) return 'stalemate';
  if (c.isDraw()) return 'draw';
  return 'playing';
}

interface GameActions {
  /**
   * Plays a move. If the viewed position is not the tip of the game, the
   * future moves are truncated first (the usual "overwrite line" behaviour).
   * Returns false for illegal moves.
   */
  makeMove: (from: string, to: string, promotion?: string) => boolean;
  undo: () => void;
  goTo: (ply: number) => void;
  first: () => void;
  prev: () => void;
  next: () => void;
  last: () => void;
  flip: () => void;
  reset: () => void;
  loadFen: (fen: string) => boolean;
  loadPgn: (pgn: string) => boolean;
}

export type GameStore = GameState & GameActions;

export const useGameStore = create<GameStore>()((set, get) => ({
  ...initialState(),

  makeMove: (from, to, promotion) => {
    const s = get();
    const chess = chessAt(s);
    const piece = chess.get(from as Parameters<Chess['get']>[0]);
    const isPromo = piece?.type === 'p' && (to[1] === '8' || to[1] === '1');
    // TODO: show a promotion dialog (later task); default to queen for now.
    const promo = isPromo ? (promotion ?? 'q') : undefined;
    let result;
    try {
      result = chess.move({ from, to, promotion: promo as PieceSymbol | undefined });
    } catch {
      return false;
    }
    const record: MoveRecord = {
      san: result.san,
      from: result.from,
      to: result.to,
      fen: chess.fen(),
      ...(result.promotion ? { promotion: result.promotion } : {}),
    };
    set({ moves: [...s.moves.slice(0, s.ply), record], ply: s.ply + 1 });
    return true;
  },

  undo: () => {
    const s = get();
    if (s.ply === 0) return;
    // Removes the last move of the viewed line (and anything after it).
    set({ moves: s.moves.slice(0, s.ply - 1), ply: s.ply - 1 });
  },

  goTo: (ply) => {
    const { moves } = get();
    set({ ply: Math.max(0, Math.min(moves.length, Math.trunc(ply))) });
  },
  first: () => get().goTo(0),
  prev: () => get().goTo(get().ply - 1),
  next: () => get().goTo(get().ply + 1),
  last: () => get().goTo(get().moves.length),

  flip: () => set((s) => ({ orientation: s.orientation === 'white' ? 'black' : 'white' })),

  reset: () => set((s) => ({ ...initialState(), orientation: s.orientation })),

  loadFen: (fen) => {
    let normalized: string;
    try {
      normalized = new Chess(fen.trim()).fen();
    } catch {
      return false;
    }
    set({ ...initialState(), startFen: normalized, orientation: get().orientation });
    return true;
  },

  loadPgn: (pgn) => {
    const chess = new Chess();
    try {
      chess.loadPgn(pgn);
    } catch {
      return false;
    }
    const history = chess.history({ verbose: true });
    const headers = chess.getHeaders() as Record<string, string | null>;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (v != null) clean[k] = v;
    const startFen = history[0]?.before ?? chess.fen();
    const moves: MoveRecord[] = history.map((m) => ({
      san: m.san,
      from: m.from,
      to: m.to,
      fen: m.after,
      ...(m.promotion ? { promotion: m.promotion } : {}),
    }));
    set({
      startFen,
      moves,
      ply: moves.length,
      headers: clean,
      orientation: get().orientation,
    });
    return true;
  },
}));
