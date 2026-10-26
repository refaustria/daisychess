/**
 * Sharing (M26-5): the native share sheet in the apps (`@capacitor/share`), `navigator.share`
 * on the web where the browser has it; callers keep their Copy button as the fallback.
 */
import { isNativeApp } from './index';
import { loadShare, type SharePort } from './native';

export interface ShareContent {
  title?: string;
  text?: string;
  url?: string;
}

export type ShareResult = 'shared' | 'cancelled' | 'unavailable' | 'failed';

/** True when a share sheet exists here (always in the apps, else the browser's Web Share API). */
export function canShare(): boolean {
  if (isNativeApp()) return true;
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

const cancelled = (e: unknown): boolean =>
  (e instanceof Error && e.name === 'AbortError') ||
  /cancel/i.test(e instanceof Error ? e.message : String(e));

/** Opens the share sheet. `port` is a test seam; by default the native plugin or the Web Share API. */
export async function shareContent(
  content: ShareContent,
  port?: SharePort | null,
): Promise<ShareResult> {
  try {
    const native = port !== undefined ? port : await loadShare();
    if (native) {
      await native.share(content);
      return 'shared';
    }
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      await navigator.share(content);
      return 'shared';
    }
    return 'unavailable';
  } catch (e) {
    return cancelled(e) ? 'cancelled' : 'failed';
  }
}
