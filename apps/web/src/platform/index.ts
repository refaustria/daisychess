/**
 * Platform seam (ADR-022): the one place that knows whether the app runs inside the Capacitor
 * shell of `apps/mobile`. On the web every function here is a constant no-op: the checks are
 * guarded by the build mode, so `vite build` (mode `production`) folds them to `false`/`null`.
 *
 * No `@capacitor/core` import: the native runtime injects `window.Capacitor` before any page
 * script runs, which is all these checks need (and keeps the web bundle free of Capacitor).
 */

export type NativePlatform = 'android' | 'ios';

/** The part of the global the Capacitor native bridge defines that the seam reads. */
interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

/** Build mode of the app bundled into the native projects (`vite build --mode mobile`). */
export const MOBILE_BUILD_MODE = 'mobile';

/** True in the `--mode mobile` bundle (whether or not it currently runs in the native shell). */
export function isMobileBuild(): boolean {
  return import.meta.env.MODE === MOBILE_BUILD_MODE;
}

function bridge(): CapacitorBridge | undefined {
  return (globalThis as { Capacitor?: CapacitorBridge }).Capacitor;
}

/** True when the page runs inside the iOS/Android app; always false in the web build. */
export function isNativeApp(): boolean {
  if (!isMobileBuild()) return false;
  try {
    return bridge()?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/** `android` / `ios` inside the app, `null` on the web (and for any platform we do not ship). */
export function nativePlatform(): NativePlatform | null {
  if (!isNativeApp()) return null;
  const p = bridge()?.getPlatform?.();
  return p === 'android' || p === 'ios' ? p : null;
}
