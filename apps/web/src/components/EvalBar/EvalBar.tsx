import { evalBarShare, formatScore, type Score } from '@chesslab/engine-core';
import { useRef } from 'react';
import { useAnalysisStore, type TerminalKind } from '../../store/analysisStore';
import { useGameStore, type Orientation } from '../../store/gameStore';
import styles from './EvalBar.module.css';

export interface EvalBarProps {
  /** White-POV score of the best line; null/undefined = no evaluation (neutral bar). */
  score?: Score | null;
  orientation: Orientation;
  /** Position the bar refers to (exposed as `data-fen`). */
  fen?: string;
  /** Checkmate/stalemate: shows the result instead of a score. */
  terminal?: TerminalKind | null;
  /** True while showing the previous position's score until the first info of the new one arrives. */
  stale?: boolean;
}

interface Display {
  /** White's share 0..100. */
  share: number;
  label: string | null;
  aria: string;
}

export function evalDisplay(
  score: Score | null | undefined,
  terminal: TerminalKind | null | undefined,
  fen?: string,
): Display {
  if (terminal === 'checkmate') {
    // The side to move is mated.
    const whiteWins = fen?.split(' ')[1] === 'b';
    return {
      share: whiteWins ? 100 : 0,
      label: whiteWins ? '1-0' : '0-1',
      aria: `Checkmate, ${whiteWins ? 'White' : 'Black'} wins`,
    };
  }
  if (terminal === 'stalemate') return { share: 50, label: '½-½', aria: 'Stalemate, draw' };
  if (!score) return { share: 50, label: null, aria: 'Evaluation unavailable' };
  const label = formatScore(score);
  return { share: evalBarShare(score), label, aria: `Evaluation ${label}` };
}

/** Vertical evaluation bar; White's share grows from White's side of the board. */
export function EvalBar({ score, orientation, fen, terminal, stale }: EvalBarProps) {
  const { share, label, aria } = evalDisplay(score, terminal, fen);
  // White at the bottom when the board shows White at the bottom.
  const whiteAtBottom = orientation === 'white';
  const whiteSide = share >= 50;
  const labelAtBottom = whiteSide === whiteAtBottom;
  return (
    <div
      className={styles.bar}
      role="img"
      aria-label={aria}
      data-testid="eval-bar"
      data-fen={fen}
      data-share={share.toFixed(1)}
      data-orientation={orientation}
    >
      <div className={styles.track}>
        <div
          className={styles.white}
          data-testid="eval-white"
          style={{ height: `${share}%`, [whiteAtBottom ? 'bottom' : 'top']: 0 }}
        />
      </div>
      {label !== null && (
        <span
          className={[
            styles.label,
            labelAtBottom ? styles.bottom : styles.top,
            whiteSide ? styles.onWhite : styles.onBlack,
            stale ? styles.stale : '',
          ].join(' ')}
          data-testid="eval-label"
          aria-hidden="true"
        >
          {label}
        </span>
      )}
    </div>
  );
}

/** {@link EvalBar} bound to the analysis and game stores. */
export function ConnectedEvalBar() {
  const orientation = useGameStore((s) => s.orientation);
  const enabled = useAnalysisStore((s) => s.enabled);
  const status = useAnalysisStore((s) => s.status);
  const fen = useAnalysisStore((s) => s.fen);
  const terminal = useAnalysisStore((s) => s.terminal);
  const best = useAnalysisStore((s) => s.lines[0]?.score ?? null);
  // Keep the previous score while the new position's first info is pending, so the bar does not
  // bounce to 50 % on every navigation step.
  const last = useRef<Score | null>(null);
  const active = enabled && status !== 'error' && status !== 'idle';
  if (!active) last.current = null;
  else if (best) last.current = best;
  const score = active ? (best ?? (terminal ? null : last.current)) : null;
  return (
    <EvalBar
      score={score}
      orientation={orientation}
      fen={fen}
      terminal={active ? terminal : null}
      stale={active && !best && !terminal && score !== null}
    />
  );
}
