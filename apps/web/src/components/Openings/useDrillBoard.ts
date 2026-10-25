import type { DrawShape } from 'chessground/draw';
import { useMemo } from 'react';
import { useGameStore, type Orientation } from '../../store/gameStore';
import { drillArrows, drillMovableColor, useDrillStore } from '../../trainer/drillState';
import { uciArrow } from '../Analysis/shapes';

/**
 * `movableColor` for the board while an openings drill runs: the user's colour on their turn at
 * the tip, nobody while the app plays a book move, the engine checks or a rejected move waits for
 * "Try again". `undefined` when no drill runs (the board decides as usual).
 */
export function useDrillMovableColor(): Orientation | null | undefined {
  const status = useDrillStore((s) => s.status);
  const phase = useDrillStore((s) => s.phase);
  const userColor = useDrillStore((s) => s.userColor);
  const atTip = useGameStore((s) => s.ply === s.moves.length);
  return drillMovableColor({ status, phase, userColor }, atTip);
}

const NONE: DrawShape[] = [];

/** Arrows of a rejected move: the move (red) and the engine's best move (green). */
export function useDrillArrows(): DrawShape[] {
  const feedback = useDrillStore((s) => (s.status === 'running' ? s.feedback : undefined));
  return useMemo(() => {
    const arrows = drillArrows(feedback)
      .map((a) => uciArrow(a.uci, a.brush))
      .filter((s): s is DrawShape => s !== null);
    return arrows.length ? arrows : NONE;
  }, [feedback]);
}
