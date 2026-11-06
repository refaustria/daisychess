import type { DrawShape } from 'chessground/draw';
import type { Key } from 'chessground/types';
import { useMemo } from 'react';
import { lessonMarks, lessonMovableColor, useLessonStore } from '../../endgames/lessonSession';
import { useGameStore, type Orientation } from '../../store/gameStore';

/**
 * `movableColor` for the board while an endgame lesson runs: the user's colour on their turn at
 * the tip, nobody while a move is judged, the opponent replies or the lesson is prepared.
 * `undefined` when no lesson runs (the board decides as usual).
 */
export function useEndgameMovableColor(): Orientation | null | undefined {
  const status = useLessonStore((s) => s.status);
  const game = useLessonStore((s) => s.game);
  const thinking = useLessonStore((s) => s.thinking);
  const atTip = useGameStore((s) => s.ply === s.moves.length);
  return lessonMovableColor({ status, game, thinking }, atTip);
}

const NONE: DrawShape[] = [];

/** Board marks of a lesson: thrown move and keeper, the shown move, the hinted piece. */
export function useEndgameShapes(): DrawShape[] {
  const status = useLessonStore((s) => s.status);
  const game = useLessonStore((s) => s.game);
  const thrown = useLessonStore((s) => s.thrown);
  return useMemo(() => {
    const marks = lessonMarks({ status, game, thrown });
    if (marks.length === 0) return NONE;
    return marks.map((m) =>
      m.dest
        ? { orig: m.orig as Key, dest: m.dest as Key, brush: m.brush }
        : { orig: m.orig as Key, brush: m.brush },
    );
  }, [status, game, thrown]);
}
