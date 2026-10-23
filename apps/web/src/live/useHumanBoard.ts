import { useMemo } from 'react';
import { usePlayStore } from '../play/playStore';
import { useGameStore, type Orientation } from '../store/gameStore';
import { useSettingsStore, type PremoveMode } from '../store/settingsStore';
import { useLiveStore } from './liveStore';

export interface HumanBoard {
  /** The user's colour at the tip of the game, null while browsing earlier moves. */
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

/**
 * Board settings while the user plays an opponent (null otherwise): a live lichess game or a game
 * against the local engine. Only the user's pieces move, only at the tip of the game; on the
 * opponent's turn a drag adds a premove (settings `premoves`).
 */
export function useHumanBoard(): HumanBoard | null {
  const liveColor = useLiveStore((s) => (s.status === 'playing' ? s.game?.color : undefined));
  const livePremoves = useLiveStore((s) => s.premoves);
  const playColor = usePlayStore((s) => (s.mode === 'playing' ? s.playerColor : undefined));
  const playPremoves = usePlayStore((s) => s.premoves);
  const premoveMode = useSettingsStore((s) => s.premoves);
  const atTip = useGameStore((s) => s.ply === s.moves.length);
  return useMemo(() => {
    const color = liveColor ?? playColor;
    if (!color) return null;
    const src = liveColor ? live : play;
    return {
      movableColor: atTip ? color : null,
      premoveMode,
      premoves: liveColor ? livePremoves : playPremoves,
      onPremove: src.add,
      onPremoveCancel: src.clear,
    };
  }, [liveColor, playColor, livePremoves, playPremoves, premoveMode, atTip]);
}
