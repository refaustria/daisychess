import { create } from 'zustand';

export type TabId = 'moves' | 'play' | 'live' | 'import' | 'review' | 'explorer' | 'settings';

interface UiStore {
  /** Active side-panel tab (lets panels switch tabs, e.g. Play → Review). */
  activeTab: TabId;
  setActiveTab(tab: TabId): void;
}

export const useUiStore = create<UiStore>()((set) => ({
  activeTab: 'moves',
  setActiveTab: (activeTab) => set({ activeTab }),
}));
