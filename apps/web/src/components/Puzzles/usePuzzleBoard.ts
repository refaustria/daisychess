import type { DrawShape } from 'chessground/draw';
import type { Key } from 'chessground/types';
import { useMemo } from 'react';
import { puzzleMarks, puzzleMovableColor, usePuzzleStore } from '../../puzzles/puzzleStore';
import { useGameStore, type Orientation } from '../../store/gameStore';

/**
 * `movableColor` for the board while a puzzle runs: the user's colour on their turn at the tip,
 * nobody while the app plays, a wrong move is shown or the next puzzle loads. `undefined` when no
 * puzzle runs (the board decides as usual).
 */
export function usePuzzleMovableColor(): Orientation | null | undefined {
  const status = usePuzzleStore((s) => s.status);
  const solver = usePuzzleStore((s) => s.solver);
  const wrongOnBoard = usePuzzleStore((s) => s.wrongOnBoard);
  const atTip = useGameStore((s) => s.ply === s.moves.length);
  return puzzleMovableColor({ status, solver, wrongOnBoard }, atTip);
}

const NONE: DrawShape[] = [];

/** Board marks of a puzzle: the wrong move (red arrow) and the hinted piece (green circle). */
export function usePuzzleShapes(): DrawShape[] {
  const status = usePuzzleStore((s) => s.status);
  const solver = usePuzzleStore((s) => s.solver);
  return useMemo(() => {
    const marks = puzzleMarks({ status, solver });
    if (marks.length === 0) return NONE;
    return marks.map((m) =>
      m.dest
        ? { orig: m.orig as Key, dest: m.dest as Key, brush: m.brush }
        : { orig: m.orig as Key, brush: m.brush },
    );
  }, [status, solver]);
}
