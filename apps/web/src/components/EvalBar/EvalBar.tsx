import { evalBarShare, formatScore, type Score } from '@daisychess/engine-core';
import { tbScoreHint, type TbScoreHint } from '@daisychess/endgames';
import { useEffect, useMemo, useRef } from 'react';
import { useLessonStore } from '../../endgames/lessonSession';
import { useTablebaseStore } from '../../endgames/tablebaseStore';
import { selectPrimary, useAnalysisStore, type TerminalKind } from '../../store/analysisStore';
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
  /** Exact tablebase result of `fen` (ADR-025 §4): wins over the engine score. */
  tablebase?: TbScoreHint | null;
}

interface Display {
  /** White's share 0..100. */
  share: number;
  label: string | null;
  aria: string;
  /** Small line under the label (`tablebase`). */
  caption?: string;
}

/** The bar for a tablebase result: 100 / 50 / 0, `M14` (or `-M14`) when DTM is known, else `TB`. */
function tablebaseDisplay(tb: TbScoreHint): Display {
  if (tb.result === 'draw') {
    return {
      share: 50,
      label: 'TB',
      aria: tb.exact50 ? 'Tablebase: draw' : 'Tablebase: draw (50-move rule)',
      caption: 'tablebase',
    };
  }
  const white = tb.result === 'white';
  const mate = tb.mateIn !== undefined ? `, mate in ${tb.mateIn}` : '';
  return {
    share: white ? 100 : 0,
    label: tb.mateIn !== undefined ? `${white ? '' : '-'}M${tb.mateIn}` : 'TB',
    aria: `Tablebase: ${white ? 'White' : 'Black'} wins${mate}`,
    caption: 'tablebase',
  };
}

export function evalDisplay(
  score: Score | null | undefined,
  terminal: TerminalKind | null | undefined,
  fen?: string,
  tablebase?: TbScoreHint | null,
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
  if (tablebase) return tablebaseDisplay(tablebase);
  if (!score) return { share: 50, label: null, aria: 'Evaluation unavailable' };
  const label = formatScore(score);
  return { share: evalBarShare(score), label, aria: `Evaluation ${label}` };
}

/** Vertical evaluation bar; White's share grows from White's side of the board. */
export function EvalBar({ score, orientation, fen, terminal, stale, tablebase }: EvalBarProps) {
  const { share, label, aria, caption } = evalDisplay(score, terminal, fen, tablebase);
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
      data-tablebase={caption ? 'true' : undefined}
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
            stale && !caption ? styles.stale : '',
          ].join(' ')}
          data-testid="eval-label"
          aria-hidden="true"
        >
          {label}
          {caption && (
            <span className={styles.caption} data-testid="eval-caption">
              {caption}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * The tablebase result of `fen` for the analysis board (ADR-025 §4): asks the tablebase store
 * (debounced, shared with the tablebase panel; refusals such as > 7 pieces cost no request) while
 * `active`, and returns the display hint once the answer for this very FEN is there.
 */
export function useAnalysisTablebase(fen: string, active: boolean): TbScoreHint | null {
  const lookup = useTablebaseStore((s) => s.lookup);
  const current = useTablebaseStore((s) => s.current);
  useEffect(() => {
    if (active && fen) lookup(fen);
  }, [active, fen, lookup]);
  const pos =
    active && current.fen === fen && current.status === 'done' ? current.answer?.pos : undefined;
  return useMemo(() => (pos ? tbScoreHint(pos) : null), [pos]);
}

/** {@link EvalBar} bound to the analysis, game and tablebase stores. */
export function ConnectedEvalBar() {
  const orientation = useGameStore((s) => s.orientation);
  const enabled = useAnalysisStore((s) => s.enabled);
  const status = useAnalysisStore((s) => selectPrimary(s).status);
  const fen = useAnalysisStore((s) => s.fen);
  const terminal = useAnalysisStore((s) => s.terminal);
  const best = useAnalysisStore((s) => selectPrimary(s).lines[0]?.score ?? null);
  // Keep the previous score while the new position's first info is pending, so the bar does not
  // bounce to 50 % on every navigation step.
  const last = useRef<Score | null>(null);
  const active = enabled && status !== 'error' && status !== 'idle';
  if (!active) last.current = null;
  else if (best) last.current = best;
  const score = active ? (best ?? (terminal ? null : last.current)) : null;
  // The exact value wins over the engine score for the same FEN (the lines still show).
  // Not while an endgame lesson runs: the lesson must not show the answer.
  const lessonRunning = useLessonStore((s) => s.status === 'running');
  const tablebase = useAnalysisTablebase(fen, enabled && !lessonRunning);
  return (
    <EvalBar
      score={score}
      orientation={orientation}
      fen={fen}
      terminal={active ? terminal : null}
      stale={active && !best && !terminal && score !== null}
      tablebase={tablebase}
    />
  );
}
