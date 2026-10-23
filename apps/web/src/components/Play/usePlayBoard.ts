import { usePlayStore } from '../../play/playStore';
import { useGameStore, type Orientation } from '../../store/gameStore';

/**
 * `movableColor` for the board: while a game against the engine runs, only the player's colour
 * may move, and only at the tip of the game while the engine is not thinking.
 */
export function usePlayMovableColor(): Orientation | null | undefined {
  const mode = usePlayStore((s) => s.mode);
  const playerColor = usePlayStore((s) => s.playerColor);
  const thinking = usePlayStore((s) => s.thinking);
  const atTip = useGameStore((s) => s.ply === s.moves.length);
  if (mode !== 'playing') return undefined;
  return thinking || !atTip ? null : playerColor;
}
