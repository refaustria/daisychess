/**
 * App lifecycle in the native shell (ADR-022 §2, M26-4): iOS ends the WebContent process of an
 * app that holds a lot of memory in the background, so the browser engines are released when the
 * app goes to the background and recreated when it comes back.
 *
 * It reuses the page-lifetime path of ADR-015 / M19-1: the live analysis and the engine game
 * already release their engine on `pagehide` and restart on a persisted `pageshow` (bfcache), and
 * the shared batch engine pool is trimmed. A short grace period keeps transient `inactive` states
 * (a system dialog, the control centre) from tearing the engine down.
 */
import { browserEnginePool } from '../engine/wasmPool';
import { loadAppState, type AppStatePort } from './native';

export const BACKGROUND_GRACE_MS = 2500;

export interface LifecycleEnv {
  dispatch(e: Event): void;
  trimPool(): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const defaultEnv = (): LifecycleEnv => ({
  dispatch: (e) => window.dispatchEvent(e),
  trimPool: () => browserEnginePool.trim(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

function pageshow(): Event {
  // PageTransitionEvent is not constructible everywhere (tests); the listeners read `persisted`.
  if (typeof PageTransitionEvent === 'function')
    return new PageTransitionEvent('pageshow', { persisted: true });
  return Object.assign(new Event('pageshow'), { persisted: true });
}

/** Returns the `appStateChange` handler. */
export function createLifecycle(env: LifecycleEnv = defaultEnv()): (isActive: boolean) => void {
  let timer: unknown = null;
  let released = false;
  return (isActive) => {
    if (isActive) {
      if (timer !== null) {
        env.clearTimer(timer);
        timer = null;
      }
      if (released) {
        released = false;
        env.dispatch(pageshow());
      }
      return;
    }
    if (timer !== null || released) return;
    timer = env.setTimer(() => {
      timer = null;
      released = true;
      env.dispatch(new Event('pagehide'));
      void env.trimPool().catch(() => undefined);
    }, BACKGROUND_GRACE_MS);
  };
}

export async function startLifecycle(port: AppStatePort, env?: LifecycleEnv): Promise<void> {
  await port.onStateChange(createLifecycle(env));
}

export async function installLifecycle(): Promise<void> {
  const port = await loadAppState();
  if (port) await startLifecycle(port);
}
