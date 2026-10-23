import '@chesslab/ui-theme/base.css';
import { useMemo, useState } from 'react';
import { AnalysisPanel } from './components/Analysis/AnalysisPanel';
import { PreviewBanner } from './components/Analysis/PreviewBanner';
import { analysisShapes } from './components/Analysis/shapes';
import { Board } from './components/Board/Board';
import { Controls } from './components/Controls/Controls';
import { EngineToggle } from './components/EngineToggle/EngineToggle';
import { ConnectedEvalBar } from './components/EvalBar/EvalBar';
import { ImportPanel } from './components/Import/ImportPanel';
import { ReviewPanel } from './components/Review/ReviewPanel';
import { SettingsPanel } from './components/Settings/SettingsPanel';
import { ThemeToggle } from './components/ThemeToggle/ThemeToggle';
import { MoveList } from './components/MoveList/MoveList';
import { selectPrimary, useAnalysisStore } from './store/analysisStore';
import { usePreviewStore } from './store/previewStore';
import {
  currentFen,
  gameStatus,
  isCheck,
  turn,
  useGameStore,
  type GameState,
} from './store/gameStore';
import styles from './App.module.css';

export function statusText(s: GameState): string {
  const side = turn(s);
  switch (gameStatus(s)) {
    case 'checkmate':
      return `Checkmate — ${side === 'white' ? 'Black' : 'White'} wins`;
    case 'stalemate':
      return 'Stalemate — draw';
    case 'draw':
      return 'Draw';
    default:
      if (isCheck(s)) return 'Check!';
      return `${side === 'white' ? 'White' : 'Black'} to move`;
  }
}

/** Board wired to the preview store and the engine's arrows. */
function ConnectedBoard() {
  const previewFen = usePreviewStore((s) => s.fen);
  const hover = usePreviewStore((s) => s.hover);
  const gameFen = useGameStore(currentFen);
  const enabled = useAnalysisStore((s) => s.enabled);
  const terminal = useAnalysisStore((s) => s.terminal);
  const analysisFen = useAnalysisStore((s) => s.fen);
  // The best-move arrow comes from the primary (first enabled) engine.
  const best = useAnalysisStore((s) => selectPrimary(s).lines[0]?.pv[0]);
  const shapes = useMemo(
    () =>
      analysisShapes({
        enabled,
        terminal: terminal !== null,
        previewing: previewFen !== null,
        inSync: analysisFen === gameFen,
        best,
        hover,
      }),
    [enabled, terminal, previewFen, analysisFen, gameFen, best, hover],
  );
  return <Board shapes={shapes} previewFen={previewFen} />;
}

export function App() {
  const state = useGameStore();
  const [tab, setTab] = useState<'moves' | 'import' | 'review' | 'settings'>('moves');
  const alert = gameStatus(state) === 'checkmate' || isCheck(state);
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>ChessLab</h1>
        <ThemeToggle />
      </header>
      <main className={styles.main}>
        <div className={styles.boardCol}>
          <ConnectedEvalBar />
          <div className={styles.boardWrap}>
            <ConnectedBoard />
            <PreviewBanner />
          </div>
        </div>
        <section className={styles.side}>
          <EngineToggle />
          <p
            className={alert ? `${styles.status} ${styles.statusAlert}` : styles.status}
            data-testid="status"
          >
            {statusText(state)}
          </p>
          <Controls />
          <AnalysisPanel />
          <div className={styles.tabs} role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'moves'}
              className={tab === 'moves' ? styles.tabActive : styles.tab}
              onClick={() => setTab('moves')}
            >
              Moves
            </button>
            <button
              role="tab"
              aria-selected={tab === 'import'}
              className={tab === 'import' ? styles.tabActive : styles.tab}
              onClick={() => setTab('import')}
            >
              Import
            </button>
            <button
              role="tab"
              aria-selected={tab === 'review'}
              className={tab === 'review' ? styles.tabActive : styles.tab}
              onClick={() => setTab('review')}
            >
              Review
            </button>
            <button
              role="tab"
              aria-selected={tab === 'settings'}
              className={tab === 'settings' ? styles.tabActive : styles.tab}
              onClick={() => setTab('settings')}
            >
              Settings
            </button>
          </div>
          <div className={styles.content}>
            {tab === 'moves' && <MoveList />}
            {tab === 'import' && <ImportPanel onLoaded={() => setTab('moves')} />}
            {tab === 'review' && <ReviewPanel />}
            {tab === 'settings' && <SettingsPanel />}
          </div>
        </section>
      </main>
    </div>
  );
}
