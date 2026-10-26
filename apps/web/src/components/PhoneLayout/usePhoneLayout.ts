import { useSyncExternalStore } from 'react';

/**
 * Phone portrait layout (M29-6): fixed action bar under the board, bottom tab bar, "⋯" menu.
 * Keep in sync with the media query in App.module.css (the CSS hides the panel buttons that the
 * action bar duplicates, `[data-phone-bar]`). Landscape phones and tablets keep the regular layout.
 */
export const PHONE_QUERY = '(max-width: 600px) and (orientation: portrait)';

function query(): MediaQueryList | undefined {
  try {
    return typeof window !== 'undefined' ? window.matchMedia?.(PHONE_QUERY) : undefined;
  } catch {
    return undefined;
  }
}

function subscribe(cb: () => void): () => void {
  const mq = query();
  if (!mq) return () => undefined;
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

const snapshot = (): boolean => query()?.matches === true;

/** True while the phone portrait layout applies (false without matchMedia, e.g. jsdom). */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
