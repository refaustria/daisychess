import { usePlayStore, type PlayState } from '../play/playStore';
import { isRoomLocked, ROOM_FAIR_PLAY_TEXT, useRoomStore, type RoomState } from '../room/roomStore';
import { FAIR_PLAY_TEXT, isLiveLocked, useLiveStore, type LiveState } from './liveStore';

/**
 * The single "human game" rule for engine features (live analysis, review, explorer).
 *
 * - `live`: a lichess game runs or a seek/challenge is pending. Engines are hard-locked (lichess
 *   fair play): live analysis is forced off (the live store reverts any attempt to switch it on),
 *   review cannot start and the auto review is skipped.
 * - `room`: the user plays a running game against a friend (ADR-013); same hard lock, enforced
 *   by the room store. Spectators of a room are not locked.
 * - `engine`: a local game against the engine runs; live analysis is paused for its duration.
 */
export type HumanGameLock = 'live' | 'room' | 'engine' | null;

export function humanGameLock(
  play: Pick<PlayState, 'mode'>,
  live: Pick<LiveState, 'status'>,
  room?: Pick<RoomState, 'phase' | 'room'>,
): HumanGameLock {
  if (isLiveLocked(live)) return 'live';
  if (room && isRoomLocked(room)) return 'room';
  if (play.mode === 'playing') return 'engine';
  return null;
}

/** Non-React check (store callbacks, guards). */
export function isHumanGameRunning(): boolean {
  return humanGameLockReason() !== null;
}

export function humanGameLockReason(): HumanGameLock {
  return humanGameLock(usePlayStore.getState(), useLiveStore.getState(), useRoomStore.getState());
}

/** True while any human game runs (React). */
export function useHumanGameLock(): boolean {
  return useHumanGameLockReason() !== null;
}

/** Which game locks the engines (React). */
export function useHumanGameLockReason(): HumanGameLock {
  const playing = usePlayStore((p) => p.mode === 'playing');
  const live = useLiveStore((l) => isLiveLocked(l));
  const room = useRoomStore((r) => isRoomLocked(r));
  return live ? 'live' : room ? 'room' : playing ? 'engine' : null;
}

/** Tooltip for disabled engine controls. */
export function lockText(lock: HumanGameLock): string | undefined {
  if (lock === 'live') return FAIR_PLAY_TEXT;
  if (lock === 'room') return ROOM_FAIR_PLAY_TEXT;
  if (lock === 'engine') return 'Paused while playing against the engine';
  return undefined;
}
