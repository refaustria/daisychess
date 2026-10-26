import { useHumanGameLockReason } from '../../live/lock';
import { usePuzzleStore } from '../../puzzles/puzzleStore';

/** Which solver buttons apply right now; shared by the Puzzles panel and the phone action bar. */
export interface PuzzleActions {
  running: boolean;
  /** The puzzle is over (solved, missed or solution shown). */
  finished: boolean;
  /** A puzzle has been loaded (labels "Next puzzle" instead of "Start puzzles"). */
  started: boolean;
  wrong: boolean;
  canHint: boolean;
  canShow: boolean;
  nextDisabled: boolean;
  nextLabel: 'Next puzzle' | 'Start puzzles';
}

export function usePuzzleActions(): PuzzleActions {
  const status = usePuzzleStore((s) => s.status);
  const phase = usePuzzleStore((s) => s.solver?.phase);
  const hinted = usePuzzleStore((s) => !!s.solver?.hint);
  const started = usePuzzleStore((s) => s.solver !== undefined);
  const lock = useHumanGameLockReason();
  const running = status === 'running';
  return {
    running,
    finished: phase === 'complete' && (status === 'done' || status === 'idle'),
    started,
    wrong: running && phase === 'wrong',
    canHint: running && (phase === 'user' || phase === 'wrong') && !hinted,
    canShow: running && phase !== 'complete' && phase !== 'showing',
    nextDisabled: lock !== null || status === 'loading',
    nextLabel: started ? 'Next puzzle' : 'Start puzzles',
  };
}
