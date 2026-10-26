/**
 * Keep the screen on while a game, a live game, a friend game, an openings drill or a puzzle runs
 * (M26-4, M30-4).
 * No-op on the web.
 */
import { useLiveStore } from '../live/liveStore';
import { usePlayStore } from '../play/playStore';
import { isRoomLocked, useRoomStore } from '../room/roomStore';
import { useDrillStore } from '../trainer/drillStore';
import { usePuzzleStore } from '../puzzles/puzzleStore';
import { loadKeepAwake, type KeepAwakePort } from './native';

/** True while something that needs the screen on is running. */
export function shouldKeepAwake(): boolean {
  return (
    usePlayStore.getState().mode === 'playing' ||
    useLiveStore.getState().status === 'playing' ||
    isRoomLocked(useRoomStore.getState()) ||
    useDrillStore.getState().status === 'running' ||
    usePuzzleStore.getState().status === 'running'
  );
}

/** Follows the stores and calls `keepAwake`/`allowSleep` on changes. Returns the unsubscribe function. */
export function startKeepAwake(
  port: KeepAwakePort,
  wanted: () => boolean = shouldKeepAwake,
): () => void {
  let on = false;
  const update = () => {
    const want = wanted();
    if (want === on) return;
    on = want;
    void (want ? port.keepAwake() : port.allowSleep()).catch(() => undefined);
  };
  const offs = [
    usePlayStore.subscribe(update),
    useLiveStore.subscribe(update),
    useRoomStore.subscribe(update),
    useDrillStore.subscribe(update),
    usePuzzleStore.subscribe(update),
  ];
  update();
  return () => {
    offs.forEach((off) => off());
    if (on) void port.allowSleep().catch(() => undefined);
    on = false;
  };
}

export async function installKeepAwake(): Promise<(() => void) | null> {
  const port = await loadKeepAwake();
  return port ? startKeepAwake(port) : null;
}
