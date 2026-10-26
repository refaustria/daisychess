import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useRushStore } from '../../puzzles/rushStore';
import { RushPanel } from './RushPanel';
import styles from './PuzzleModes.module.css';

// Lazy: keeps the mistake store and generator out of the main bundle.
const MistakesPanel = lazy(() =>
  import('./MistakesPanel').then((m) => ({ default: m.MistakesPanel })),
);

type Mode = 'puzzles' | 'rush' | 'mistakes';

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
        <button
          type="button"
          aria-pressed={mode === 'mistakes'}
          disabled={rushActive}
          onClick={() => setMode('mistakes')}
        >
          Your mistakes
        </button>
      </div>
      {mode === 'rush' ? (
        <RushPanel />
      ) : mode === 'mistakes' ? (
        <Suspense fallback={<p role="status">Loading…</p>}>
          <MistakesPanel />
        </Suspense>
      ) : (
        children
      )}
    </div>
  );
}
