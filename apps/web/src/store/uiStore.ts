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

interface UiStore {
  /** Active side-panel tab (lets panels switch tabs, e.g. Play → Review). */
  activeTab: TabId;
  setActiveTab(tab: TabId): void;
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
  focusServerToken: false,
  openServerTokenSettings: () => set({ activeTab: 'settings', focusServerToken: true }),
  clearFocusServerToken: () => set({ focusServerToken: false }),
  notice: null,
  showNotice: (notice) => set({ notice }),
  dismissNotice: () => set({ notice: null }),
}));
