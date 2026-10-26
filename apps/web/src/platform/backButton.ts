/**
 * Android back button (M26-4): close the topmost dialog, else go back to the previous tab, else
 * (on the first tab) exit the app. Dialog components register a handler while they are open
 * ({@link useBackHandler}); the registry itself is plain TypeScript and harmless on the web.
 */
import { useEffect } from 'react';
import { useUiStore, type TabId } from '../store/uiStore';
import { loadAppState, type AppStatePort } from './native';

type BackHandler = () => boolean;
const handlers: BackHandler[] = [];

/** Registers a handler (the newest runs first); it returns true when it closed something. */
export function registerBackHandler(fn: BackHandler): () => void {
  handlers.push(fn);
  return () => {
    const i = handlers.lastIndexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** While `open`, the back button runs `close` (a dialog, popover, confirmation). */
export function useBackHandler(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => {
      close();
      return true;
    });
  }, [open, close]);
}

const HOME_TAB: TabId = 'moves';
const MAX_HISTORY = 32;

/** Tabs visited before the active one (newest last). */
const tabHistory: TabId[] = [];
let tracking: TabId = useUiStore.getState().activeTab;
let navigating = false;

/** Records tab changes for the back button (not the ones the back button itself makes). */
export function trackTabHistory(): () => void {
  tracking = useUiStore.getState().activeTab;
  return useUiStore.subscribe((s) => {
    if (s.activeTab === tracking) return;
    if (!navigating) {
      tabHistory.push(tracking);
      if (tabHistory.length > MAX_HISTORY) tabHistory.shift();
    }
    tracking = s.activeTab;
  });
}

export type BackResult = 'dialog' | 'tab' | 'exit';

/** One back press. `exit` = nothing left to go back to: the caller exits the app. */
export function handleBack(): BackResult {
  for (let i = handlers.length - 1; i >= 0; i--) {
    if (handlers[i]!()) return 'dialog';
  }
  const ui = useUiStore.getState();
  let target: TabId | undefined;
  while (tabHistory.length > 0) {
    const t = tabHistory.pop()!;
    if (t !== ui.activeTab) {
      target = t;
      break;
    }
  }
  if (!target && ui.activeTab !== HOME_TAB) target = HOME_TAB;
  if (!target) return 'exit';
  navigating = true;
  try {
    ui.setActiveTab(target);
  } finally {
    navigating = false;
  }
  return 'tab';
}

/** Test seam. */
export function resetBackButton(): void {
  handlers.length = 0;
  tabHistory.length = 0;
  tracking = useUiStore.getState().activeTab;
}

export function startBackButton(port: AppStatePort): Promise<void> {
  trackTabHistory();
  return port.onBackButton(() => {
    if (handleBack() === 'exit') void port.exitApp().catch(() => undefined);
  });
}

export async function installBackButton(): Promise<void> {
  const port = await loadAppState();
  if (port) await startBackButton(port);
}
