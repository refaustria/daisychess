import '@chesslab/ui-theme/base.css';
import { useState } from 'react';
import { Board } from './components/Board/Board';
import { Controls } from './components/Controls/Controls';
import { ImportPanel } from './components/Import/ImportPanel';
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
  return (
    <main className={styles.app}>
      <Board />
      <section className={styles.side}>
        <h1>ChessLab</h1>
        <p className={styles.status} data-testid="status">
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
        {tab === 'moves' ? <MoveList /> : <ImportPanel onLoaded={() => setTab('moves')} />}
      </section>
    </main>
  );
}
