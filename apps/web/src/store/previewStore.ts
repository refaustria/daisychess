import { create } from 'zustand';
import { useGameStore } from './gameStore';

export interface PreviewState {
  /** Position shown read-only on the board instead of the game position; null = no preview. */
  fen: string | null;
  /** SAN moves of the previewed line (informational). */
  moves: string[];
  /** UCI moves of the engine line under the pointer, drawn as arrows. */
  hover: string[] | null;
  start(fen: string, moves: string[]): void;
  clear(): void;
  setHover(moves: string[] | null): void;
}

export const usePreviewStore = create<PreviewState>()((set, get) => ({
  fen: null,
  moves: [],
  hover: null,
  start: (fen, moves) => set({ fen, moves }),
  clear: () => {
    if (get().fen !== null) set({ fen: null, moves: [] });
  },
  setHover: (hover) => set({ hover }),
}));

// A preview belongs to the position it was started from: any game navigation ends it.
useGameStore.subscribe((s, prev) => {
  if (s !== prev) usePreviewStore.getState().clear();
});
