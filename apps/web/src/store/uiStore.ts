import { create } from 'zustand';

export type TabId =
  | 'moves'
  | 'play'
  | 'openings'
  | 'puzzles'
  | 'live'
  | 'friend'
  | 'import'
  | 'review'
  | 'explorer'
  | 'settings';

/** Mode shown in the Puzzles tab (mirrored by the panel for the phone action bar, M29-6). */
export type PuzzleMode = 'puzzles' | 'rush' | 'mistakes';

interface UiStore {
  /** Active side-panel tab (lets panels switch tabs, e.g. Play → Review). */
  activeTab: TabId;
  setActiveTab(tab: TabId): void;
  /** The mode the Puzzles tab currently shows (set by the panel; read by the phone action bar). */
  puzzleMode: PuzzleMode;
  setPuzzleMode(mode: PuzzleMode): void;
  /** Set by {@link openServerTokenSettings}: the Settings token field focuses itself, then clears it. */
  focusServerToken: boolean;
  /** Opens the Settings tab and asks its server token field to take focus. */
  openServerTokenSettings(): void;
  clearFocusServerToken(): void;
  /** One-time notice (e.g. "Server access token saved on this device"); null = none. */
  notice: string | null;
  showNotice(text: string): void;
  dismissNotice(): void;
}

export const useUiStore = create<UiStore>()((set) => ({
  activeTab: 'moves',
  setActiveTab: (activeTab) => set({ activeTab }),
  puzzleMode: 'puzzles',
  setPuzzleMode: (puzzleMode) => set({ puzzleMode }),
  focusServerToken: false,
  openServerTokenSettings: () => set({ activeTab: 'settings', focusServerToken: true }),
  clearFocusServerToken: () => set({ focusServerToken: false }),
  notice: null,
  showNotice: (notice) => set({ notice }),
  dismissNotice: () => set({ notice: null }),
}));
