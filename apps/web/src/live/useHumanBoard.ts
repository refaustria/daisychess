import { useMemo } from 'react';
import { usePlayStore } from '../play/playStore';
import { useRoomStore } from '../room/roomStore';
import { useGameStore, type Orientation } from '../store/gameStore';
import { useSettingsStore, type PremoveMode } from '../store/settingsStore';
import { useLiveStore } from './liveStore';

export interface HumanBoard {
  /** The user's colour at the tip of the game, null while browsing earlier moves (or nobody). */
  movableColor: Orientation | null;
  premoveMode: PremoveMode;
  /** Waiting premoves (UCI), in order. */
  premoves: readonly string[];
  onPremove(from: string, to: string): void;
  onPremoveCancel(): void;
}

const live = {
  add: (from: string, to: string) => useLiveStore.getState().addPremove(`${from}${to}`),
  clear: () => useLiveStore.getState().clearPremoves(),
};
const play = {
  add: (from: string, to: string) => usePlayStore.getState().addPremove(`${from}${to}`),
  clear: () => usePlayStore.getState().clearPremoves(),
};
const room = {
  add: (from: string, to: string) => useRoomStore.getState().addPremove(`${from}${to}`),
  clear: () => useRoomStore.getState().clearPremoves(),
};
const NO_PREMOVES: readonly string[] = [];
const noop = () => undefined;

/**
 * The board while a room is shown but the user cannot move: waiting for the friend, watching as
 * a spectator. (A finished room leaves the board free for analysis.)
 */
const READ_ONLY: HumanBoard = {
  movableColor: null,
  premoveMode: 'none',
  premoves: NO_PREMOVES,
  onPremove: noop,
  onPremoveCancel: noop,
};

/**
 * Board settings while the user plays an opponent (null otherwise): a live lichess game, a game
 * against a friend (room) or a game against the local engine. Only the user's pieces move, only
 * at the tip of the game; on the opponent's turn a drag adds a premove (settings `premoves`).
 */
export function useHumanBoard(): HumanBoard | null {
  const liveColor = useLiveStore((s) => (s.status === 'playing' ? s.game?.color : undefined));
  const livePremoves = useLiveStore((s) => s.premoves);
  const playColor = usePlayStore((s) => (s.mode === 'playing' ? s.playerColor : undefined));
  const playPremoves = usePlayStore((s) => s.premoves);
  /** The user's colour in a running room game, 'none' for a room that allows no moves. */
  const roomColor = useRoomStore((s): Orientation | 'none' | undefined => {
    if (s.phase !== 'room' || !s.room || s.room.status === 'finished') return undefined;
    return s.room.status === 'playing' && s.room.you !== 'spectator' ? s.room.you : 'none';
  });
  const roomPremoves = useRoomStore((s) => s.premoves);
  const premoveMode = useSettingsStore((s) => s.premoves);
  const atTip = useGameStore((s) => s.ply === s.moves.length);
  return useMemo(() => {
    if (roomColor === 'none') return READ_ONLY;
    const color = liveColor ?? roomColor ?? playColor;
    if (!color) return null;
    const src = liveColor ? live : roomColor ? room : play;
    return {
      movableColor: atTip ? color : null,
      premoveMode,
      premoves: liveColor ? livePremoves : roomColor ? roomPremoves : playPremoves,
      onPremove: src.add,
      onPremoveCancel: src.clear,
    };
  }, [liveColor, roomColor, playColor, livePremoves, roomPremoves, playPremoves, premoveMode, atTip]);
}
