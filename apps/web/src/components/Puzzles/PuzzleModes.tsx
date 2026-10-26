import { useState, type ReactNode } from 'react';
import { useRushStore } from '../../puzzles/rushStore';
import { RushPanel } from './RushPanel';
import styles from './PuzzleModes.module.css';

type Mode = 'puzzles' | 'rush';

/** Puzzles | Rush switch of the Puzzles tab; `children` is the regular solver panel. */
export function PuzzleModes({ children }: { children: ReactNode }) {
  const rushActive = useRushStore((s) => s.status === 'running' || s.status === 'loading');
  const [chosen, setMode] = useState<Mode>(() =>
    useRushStore.getState().status === 'idle' ? 'puzzles' : 'rush',
  );
  // A running rush keeps its panel; the other mode is unavailable until the run ends.
  const mode: Mode = rushActive ? 'rush' : chosen;
  return (
    <div className={styles.modes}>
      <div className={styles.switch} role="group" aria-label="Puzzle mode">
        <button
          type="button"
          aria-pressed={mode === 'puzzles'}
          disabled={rushActive}
          onClick={() => setMode('puzzles')}
        >
          Puzzles
        </button>
        <button type="button" aria-pressed={mode === 'rush'} onClick={() => setMode('rush')}>
          Rush
        </button>
      </div>
      {mode === 'rush' ? <RushPanel /> : children}
    </div>
  );
}
