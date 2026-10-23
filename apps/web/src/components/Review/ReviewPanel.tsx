import { MOVE_CLASSES, type ReviewSummary } from '@chesslab/engine-core';
import { useMemo, useState } from 'react';
import { annotatePgn } from '../../review/annotatePgn';
import { CLASS_INFO, bestMoveSan, moveNumberLabel } from '../../review/format';
import { REVIEW_PRESETS, useReviewStore } from '../../review/reviewStore';
import { useGameStore } from '../../store/gameStore';
import { EvalGraph } from './EvalGraph';
import styles from './ReviewPanel.module.css';

type PresetKey = keyof typeof REVIEW_PRESETS;
const PRESET_LABELS: Record<PresetKey, string> = {
  fast: 'Fast (0.3 s/move)',
  deep: 'Deep (depth 18)',
};
const MAX_MOMENTS = 10;

function download(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-chess-pgn' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'chesslab-review.pgn';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function KeyMoments({ summary }: { summary: ReviewSummary }) {
  const startFen = useGameStore((s) => s.startFen);
  const moves = useGameStore((s) => s.moves);
  const goTo = useGameStore((s) => s.goTo);
  const items = summary.moves
    .filter((m) => m.classification === 'blunder' || m.classification === 'mistake')
    .sort((a, b) => b.winProbLoss - a.winProbLoss)
    .slice(0, MAX_MOMENTS);
  if (items.length === 0) return <p className={styles.muted}>No mistakes or blunders found.</p>;
  return (
    <ul className={styles.moments}>
      {items.map((m) => {
        const info = CLASS_INFO[m.classification];
        const best = bestMoveSan(startFen, moves, m);
        return (
          <li key={m.ply}>
            <button type="button" className={styles.moment} onClick={() => goTo(m.ply)}>
              <span className={styles.momentMain}>
                <span className={styles.dot} style={{ background: info.color }} aria-hidden />
                <span>
                  {moveNumberLabel(startFen, m.ply)} {m.san ?? m.uci}
                  {info.glyph} (−{Math.round(m.winProbLoss)}%)
                </span>
              </span>
              {best && <span className={styles.best}>best was {best}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Done({ summary, onAgain }: { summary: ReviewSummary; onAgain: () => void }) {
  const headers = useGameStore((s) => s.headers);
  const startFen = useGameStore((s) => s.startFen);
  const moves = useGameStore((s) => s.moves);
  const ply = useGameStore((s) => s.ply);
  const goTo = useGameStore((s) => s.goTo);
  const [copied, setCopied] = useState(false);
  const pgn = useMemo(
    () => annotatePgn(headers, startFen, moves, summary),
    [headers, startFen, moves, summary],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pgn);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const side = (color: 'white' | 'black') => (
    <div className={styles.accuracy}>
      <span className={styles.accName}>
        {headers[color === 'white' ? 'White' : 'Black'] || (color === 'white' ? 'White' : 'Black')}
      </span>
      <span className={styles.accValue} data-testid={`accuracy-${color}`}>
        {Math.round(summary[color].accuracy)}%
      </span>
      <span className={styles.muted}>accuracy</span>
    </div>
  );
  return (
    <>
      <div className={styles.accuracies}>
        {side('white')}
        {side('black')}
      </div>
      <table className={styles.counts}>
        <thead>
          <tr>
            <th scope="col">Move type</th>
            <th scope="col">White</th>
            <th scope="col">Black</th>
          </tr>
        </thead>
        <tbody>
          {MOVE_CLASSES.map((c) => (
            <tr key={c}>
              <th scope="row">
                <span
                  className={styles.dot}
                  style={{ background: CLASS_INFO[c].color }}
                  aria-hidden
                />
                {CLASS_INFO[c].label}
              </th>
              <td>{summary.white.counts[c]}</td>
              <td>{summary.black.counts[c]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <EvalGraph summary={summary} ply={ply} onSeek={goTo} />
      <h3 className={styles.h}>Key moments</h3>
      <KeyMoments summary={summary} />
      <div className={styles.row}>
        <button type="button" className={styles.btn} onClick={() => download(pgn)}>
          Export annotated PGN
        </button>
        <button type="button" className={styles.btn} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className={styles.btn} onClick={onAgain}>
          Run again
        </button>
      </div>
    </>
  );
}

export function ReviewPanel() {
  const status = useReviewStore((s) => s.status);
  const progress = useReviewStore((s) => s.progress);
  const summary = useReviewStore((s) => s.summary);
  const error = useReviewStore((s) => s.error);
  const start = useReviewStore((s) => s.start);
  const cancel = useReviewStore((s) => s.cancel);
  const reset = useReviewStore((s) => s.reset);
  const hasMoves = useGameStore((s) => s.moves.length > 0);
  const [preset, setPreset] = useState<PresetKey>('deep');

  const run = () => void start({ ...REVIEW_PRESETS[preset] });

  if (status === 'running') {
    const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <div className={styles.wrap} data-testid="review-panel">
        <p>Reviewing… live analysis is paused.</p>
        <div
          className={styles.bar}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-label="Review progress"
        >
          <div className={styles.barFill} style={{ width: `${pct}%` }} />
        </div>
        <p className={styles.muted}>
          {progress.done}/{progress.total} ({pct}%)
        </p>
        <div className={styles.row}>
          <button type="button" className={styles.btn} onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (status === 'done' && summary) {
    return (
      <div className={styles.wrap} data-testid="review-panel">
        <Done
          summary={summary}
          onAgain={() => {
            reset();
            void start({ ...useReviewStore.getState().options });
          }}
        />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={styles.wrap} data-testid="review-panel">
        <p role="alert" className={styles.error}>
          Review failed: {error ?? 'unknown error'}
        </p>
        <div className={styles.row}>
          <button type="button" className={styles.btnPrimary} onClick={run}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrap} data-testid="review-panel">
      <p>
        Analyse every move of the game with the engine to classify mistakes, compute accuracy and
        find key moments.
        {status === 'cancelled' && ' The previous review was cancelled.'}
      </p>
      <div className={styles.row} role="radiogroup" aria-label="Review depth">
        {(Object.keys(REVIEW_PRESETS) as PresetKey[]).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={preset === k}
            className={preset === k ? styles.presetActive : styles.preset}
            onClick={() => setPreset(k)}
          >
            {PRESET_LABELS[k]}
          </button>
        ))}
      </div>
      <div className={styles.row}>
        <button type="button" className={styles.btnPrimary} disabled={!hasMoves} onClick={run}>
          Start
        </button>
        {!hasMoves && <span className={styles.muted}>Play or import a game first.</span>}
      </div>
    </div>
  );
}
