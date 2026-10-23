import { formatScore, type ReviewSummary } from '@chesslab/engine-core';
import { explainMove, findJump, type MoveDetail, type MoveDetails } from '../../review/details';
import { CLASS_INFO } from '../../review/format';
import { useGameStore } from '../../store/gameStore';
import { usePreviewStore } from '../../store/previewStore';
import styles from './ReviewPanel.module.css';

const MINUS = '−';

/** `Blunder (−53%)`; the loss is only shown when it rounds to at least 1%. */
export function classLabel(d: Pick<MoveDetail, 'classification' | 'winProbLoss'>): string {
  const label = CLASS_INFO[d.classification].label;
  const loss = Math.round(d.winProbLoss);
  return loss >= 1 ? `${label} (${MINUS}${loss}%)` : label;
}

function Body({ detail }: { detail: MoveDetail }) {
  const preview = usePreviewStore((s) => s.start);
  const info = CLASS_INFO[detail.classification];
  return (
    <>
      <p className={styles.cardTitle}>
        <span className={styles.dot} style={{ background: info.color }} aria-hidden />
        <strong data-testid="move-card-played">
          {detail.moveLabel} {detail.playedSan}
          {info.glyph}
        </strong>
        <span className={styles.cardClass} style={{ color: info.color }}>
          {classLabel(detail)}
        </span>
      </p>
      {detail.bestSan && (
        <div className={styles.better} data-testid="move-card-better">
          <span>
            Better:{' '}
            <strong>
              {detail.moveLabel} {detail.bestSan}
            </strong>
          </span>
          {detail.bestLineMoves.length > 0 && (
            <button
              type="button"
              className={styles.line}
              title="Click to preview this line on the board"
              aria-label={`Preview best line ${detail.bestLineSan}`}
              onClick={() => preview(detail.bestLineFen, detail.bestLineMoves)}
            >
              {detail.bestLineSan}
            </button>
          )}
        </div>
      )}
      <p className={styles.muted}>
        Eval {formatScore(detail.evalBeforeWhite)} → {formatScore(detail.evalAfterWhite)} (
        {detail.swing} for {detail.mover === 'white' ? 'White' : 'Black'})
      </p>
      <p data-testid="move-card-text">{explainMove(detail)}</p>
    </>
  );
}

/**
 * "Current move" card of the review: follows the game's ply and explains the move that led to the
 * displayed position, with the engine's better move and line; prev/next jump between mistakes.
 */
export function MoveCommentary({
  summary,
  details,
  running = false,
}: {
  summary: ReviewSummary;
  details: MoveDetails;
  /** The review is still running (`summary` covers the analysed prefix only). */
  running?: boolean;
}) {
  const ply = useGameStore((s) => s.ply);
  const fen = useGameStore((s) => (s.ply > 0 ? s.moves[s.ply - 1]?.fen : undefined));
  const goTo = useGameStore((s) => s.goTo);
  const d = details[ply];
  const prev = findJump(summary, ply, -1);
  const next = findJump(summary, ply, 1);

  let body;
  if (ply === 0) {
    body = (
      <p className={styles.muted}>Start position. Step through the moves or jump to a mistake.</p>
    );
  } else if (!d && running) {
    body = <p className={styles.muted}>This move has not been analysed yet.</p>;
  } else if (!d || d.fenAfter !== fen) {
    body = <p className={styles.muted}>This move is not part of the reviewed game.</p>;
  } else {
    body = <Body detail={d} />;
  }

  return (
    <section className={styles.card} aria-label="Current move" data-testid="move-card">
      <div aria-live="polite" className={styles.cardBody}>
        {body}
      </div>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.btn}
          disabled={prev === undefined}
          onClick={() => prev !== undefined && goTo(prev)}
        >
          <span aria-hidden>◀</span> Previous mistake
        </button>
        <button
          type="button"
          className={styles.btn}
          disabled={next === undefined}
          onClick={() => next !== undefined && goTo(next)}
        >
          Next mistake <span aria-hidden>▶</span>
        </button>
      </div>
    </section>
  );
}
