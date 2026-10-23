import '@chesslab/ui-theme/base.css';
import { useState } from 'react';
import { Board } from './components/Board/Board';
import { Controls } from './components/Controls/Controls';
import { ImportPanel } from './components/Import/ImportPanel';
import { ThemeToggle } from './components/ThemeToggle/ThemeToggle';
import { MoveList } from './components/MoveList/MoveList';
import { gameStatus, isCheck, turn, useGameStore, type GameState } from './store/gameStore';
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

export function App() {
  const state = useGameStore();
  const [tab, setTab] = useState<'moves' | 'import'>('moves');
  const alert = gameStatus(state) === 'checkmate' || isCheck(state);
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>ChessLab</h1>
        <ThemeToggle />
      </header>
      <main className={styles.main}>
        <div className={styles.boardCol}>
          <Board />
        </div>
        <section className={styles.side}>
          <p
            className={alert ? `${styles.status} ${styles.statusAlert}` : styles.status}
            data-testid="status"
          >
            {statusText(state)}
          </p>
          <Controls />
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
          </div>
          <div className={styles.content}>
            {tab === 'moves' ? <MoveList /> : <ImportPanel onLoaded={() => setTab('moves')} />}
          </div>
        </section>
      </main>
    </div>
  );
}
