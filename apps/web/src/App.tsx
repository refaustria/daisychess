import '@chesslab/ui-theme/base.css';
import { formatScore } from '@chesslab/engine-core';

export function App() {
  return (
    <main>
      <h1>ChessLab</h1>
      <p>
        Eval: <span data-testid="score">{formatScore({ cp: 35 })}</span>
      </p>
    </main>
  );
}
