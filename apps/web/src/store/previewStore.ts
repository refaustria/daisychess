import { Chess } from 'chess.js';
import { create } from 'zustand';
import { useGameStore } from './gameStore';

/** A steppable line: `fens[i]` is the position after `i` moves (`fens[0]` = the start). */
export interface PreviewLine {
  fens: string[];
  /** UCI of each move (`ucis[i]` leads from `fens[i]` to `fens[i + 1]`). */
  ucis: string[];
  sans: string[];
}

export interface PreviewState {
  /** Position shown read-only on the board instead of the game position; null = no preview. */
  fen: string | null;
  /** SAN moves of the previewed line (informational). */
  moves: string[];
  /** UCI moves of the engine line under the pointer, drawn as arrows. */
  hover: string[] | null;
  /** Steppable line started by {@link PreviewState.startLine}; null for a plain preview. */
  line: PreviewLine | null;
  /** Moves of `line` played on the board (0 = its start position). */
  lineIndex: number;
  /** UCI of the last stepped move (drawn as an arrow), null at the start of the line. */
  lineArrow: string | null;
  start(fen: string, moves: string[]): void;
  /**
   * Starts a steppable line at its start position; the FEN per ply is computed once. Moves that
   * are illegal from `startFen` cut the line short.
   */
  startLine(startFen: string, sans: string[]): void;
  /** Moves `delta` plies within the line (clamped to its ends); a no-op without a line. */
  stepLine(delta: number): void;
  clear(): void;
  setHover(moves: string[] | null): void;
}

function computeLine(startFen: string, sans: string[]): PreviewLine {
  const fens = [startFen];
  const ucis: string[] = [];
  const played: string[] = [];
  try {
    const chess = new Chess(startFen);
    for (const san of sans) {
      const m = chess.move(san);
      ucis.push(`${m.from}${m.to}${m.promotion ?? ''}`);
      played.push(m.san);
      fens.push(chess.fen());
    }
  } catch {
    // Illegal move or unreadable FEN: keep what was played so far.
  }
  return { fens, ucis, sans: played };
}

const NO_LINE = { line: null, lineIndex: 0, lineArrow: null } as const;

export const usePreviewStore = create<PreviewState>()((set, get) => ({
  fen: null,
  moves: [],
  hover: null,
  ...NO_LINE,
  start: (fen, moves) => set({ fen, moves, ...NO_LINE }),
  startLine: (startFen, sans) => {
    const line = computeLine(startFen, sans);
    set({ fen: startFen, moves: line.sans, line, lineIndex: 0, lineArrow: null });
  },
  stepLine: (delta) => {
    const { line, lineIndex } = get();
    if (!line) return;
    const i = Math.max(0, Math.min(line.sans.length, lineIndex + delta));
    set({
      fen: line.fens[i]!,
      lineIndex: i,
      lineArrow: i > 0 ? (line.ucis[i - 1] ?? null) : null,
    });
  },
  clear: () => {
    if (get().fen !== null) set({ fen: null, moves: [], ...NO_LINE });
  },
  setHover: (hover) => set({ hover }),
}));

// A preview belongs to the position it was started from: any game navigation ends it.
useGameStore.subscribe((s, prev) => {
  if (s !== prev) usePreviewStore.getState().clear();
});
