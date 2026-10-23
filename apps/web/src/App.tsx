import '@chesslab/ui-theme/base.css';
import { Board } from './components/Board/Board';
import { Controls } from './components/Controls/Controls';
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
  return (
    <main className={styles.app}>
      <Board />
      <section className={styles.side}>
        <h1>ChessLab</h1>
        <p className={styles.status} data-testid="status">
          {statusText(state)}
        </p>
        <Controls />
      </section>
    </main>
  );
}
