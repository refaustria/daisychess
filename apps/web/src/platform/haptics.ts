/**
 * Haptic feedback in the app (M26-4): a light tap for a move, a medium one for a capture, a heavy
 * one for check, a notification for the end of a game. Switched by `settings.haptics`; a no-op on
 * the web (the loader returns null) and when the plugin fails.
 */
import { newMoveKind, type MoveSoundKind } from '../sound/sounds';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { usePlayStore } from '../play/playStore';
import { useLiveStore } from '../live/liveStore';
import { useRoomStore } from '../room/roomStore';
import { loadHaptics, type HapticsPort } from './native';

export type GameEndFeel = 'success' | 'warning' | 'error';

/** The feedback for a move of the given kind; a checkmate (`#`) is a heavy impact like check. */
export function moveHaptic(port: HapticsPort, kind: MoveSoundKind): Promise<void> {
  return port.impact(kind === 'check' ? 'heavy' : kind === 'capture' ? 'medium' : 'light');
}

const swallow = (): undefined => undefined;

/**
 * Subscribes to the stores and fires haptics through `port`. Returns the unsubscribe function.
 * `enabled` is read on every event (the setting can change at any time).
 */
export function startHaptics(
  port: HapticsPort,
  enabled: () => boolean = () => useSettingsStore.getState().haptics,
): () => void {
  const fire = (f: () => Promise<void>) => {
    if (!enabled()) return;
    try {
      f().catch(swallow);
    } catch {
      /* haptics must never affect play */
    }
  };
  const offs = [
    useGameStore.subscribe((next, prev) => {
      const kind = newMoveKind(prev, next);
      if (kind) fire(() => moveHaptic(port, kind));
    }),
    // Engine game over (checkmate, resignation, timeout, draw …).
    usePlayStore.subscribe((s, prev) => {
      if (s.mode === 'finished' && prev.mode !== 'finished') fire(() => port.notify('success'));
    }),
    useLiveStore.subscribe((s, prev) => {
      if (s.status === 'finished' && prev.status !== 'finished') fire(() => port.notify('success'));
    }),
    useRoomStore.subscribe((s, prev) => {
      if (s.room?.status === 'finished' && prev.room?.status !== 'finished')
        fire(() => port.notify('success'));
    }),
  ];
  return () => offs.forEach((off) => off());
}

/** Native shell only: loads the plugin and starts {@link startHaptics}. */
export async function installHaptics(): Promise<(() => void) | null> {
  const port = await loadHaptics();
  return port ? startHaptics(port) : null;
}
