import type { MouseEvent } from 'react';
import { tourActive, type TourCard } from '../../review/tour';
import { stepCardLine, useTourStore } from '../../review/tourStore';
import { usePreviewStore } from '../../store/previewStore';
import { usePhoneLayout } from '../PhoneLayout/usePhoneLayout';
import styles from './ReviewTour.module.css';

const sideName = (s: 'white' | 'black'): string => (s === 'white' ? 'White' : 'Black');

/** "Stops at White's mistakes · Switch" (ADR-024 section 2). */
function SideLine() {
  const side = useTourStore((s) => s.userSide);
  if (!side) return null;
  const other = side === 'white' ? 'black' : 'white';
  return (
    <p className={styles.side}>
      Stops at {sideName(side)}&rsquo;s mistakes ·{' '}
      <button
        type="button"
        className={styles.link}
        data-testid="tour-side"
        aria-label={`Switch to ${sideName(other)}'s mistakes`}
        onClick={() => void useTourStore.getState().switchSide()}
      >
        Switch
      </button>
    </p>
  );
}

/** Body of a stop card: the opening description or the mistake (M31-6 renders the full cards). */
function CardBody({ card }: { card: TourCard }) {
  if (card.kind === 'opening') {
    return (
      <>
        <strong className={styles.title}>{card.title}</strong>
        {card.familyText && <p className={styles.para}>{card.familyText}</p>}
        {card.sentences.map((s, i) => (
          <p key={i} className={styles.para}>
            {s}
          </p>
        ))}
      </>
    );
  }
  if (card.explanation) {
    return (
      <>
        <strong className={styles.title}>{card.explanation.headline}</strong>
        {card.explanation.sentences.map((s, i) => (
          <p key={i} className={styles.para}>
            {s}
          </p>
        ))}
        {card.maia && (
          <p className={styles.para} data-testid="tour-maia">
            {card.maia}
          </p>
        )}
      </>
    );
  }
  return <p className={styles.para}>{card.text}</p>;
}

/** "Show book move" of the opening card: the book alternative, one step into the preview. */
function BookMoveButton({ preview }: { preview: { fen: string; sans: string[] } }) {
  return (
    <button
      type="button"
      className={styles.btn}
      data-testid="tour-book-move"
      onClick={() => {
        const p = usePreviewStore.getState();
        p.startLine(preview.fen, preview.sans);
        usePreviewStore.getState().stepLine(1);
      }}
    >
      Show book move
    </button>
  );
}

/** "Best line ◀ ▶" of a mistake card; `[` and `]` step it too. Shows the current move as SAN. */
function LineStepper({ line }: { line: { fen: string; sans: string[]; label: string } }) {
  const active = usePreviewStore((s) => s.line !== null && s.line.fens[0] === line.fen);
  const index = usePreviewStore((s) => (s.line?.fens[0] === line.fen ? s.lineIndex : 0));
  const total = line.sans.length;
  const current = active && index > 0 ? line.sans[index - 1] : undefined;
  return (
    <div className={styles.line} data-testid="tour-line">
      <span className={styles.lineLabel}>{line.label}</span>
      <button
        type="button"
        className={styles.btn}
        aria-label="Previous move of the line"
        aria-keyshortcuts="["
        disabled={!active || index === 0}
        onClick={() => stepCardLine(-1)}
      >
        <span aria-hidden>◀</span>
      </button>
      <button
        type="button"
        className={styles.btn}
        aria-label="Next move of the line"
        aria-keyshortcuts="]"
        disabled={active && index >= total}
        onClick={() => stepCardLine(1)}
      >
        <span aria-hidden>▶</span>
      </button>
      <span className={styles.lineStep} data-testid="tour-line-step" aria-live="polite">
        {active ? `${index}/${total}${current ? ` ${current}` : ''}` : `${total} moves`}
      </span>
    </div>
  );
}

/** Controls under the card text (outside its status region). */
function CardControls({ card }: { card: TourCard }) {
  if (card.kind === 'opening') {
    return card.preview ? (
      <div className={styles.line}>
        <BookMoveButton preview={card.preview} />
      </div>
    ) : null;
  }
  const line = card.explanation?.line;
  return line && line.sans.length > 0 ? <LineStepper line={line} /> : null;
}

/** A click/tap on the stop card continues the tour, unless it hit a control inside the card. */
function onCardClick(e: MouseEvent<HTMLElement>) {
  if (e.target instanceof Element && e.target.closest('button, a, input, select, textarea')) return;
  useTourStore.getState().next();
}

/**
 * Guided-tour bar of the Review panel (M20-2, ADR-024 section 1): progress through the stops,
 * Pause/Resume · Next · Stop (on phones these are in the action bar instead), skip to the next
 * stop and the user's side with "Switch". At a stop the card is a labelled section whose text is
 * a status region; elsewhere the current highlight's text is. After the tour "Replay tour"
 * remains.
 */
export function ReviewTour() {
  const phone = usePhoneLayout();
  const status = useTourStore((s) => s.status);
  const total = useTourStore((s) => s.total);
  const reached = useTourStore((s) => s.reached);
  const text = useTourStore((s) => s.text);
  const card = useTourStore((s) => s.card);
  const { start, next, pause, resume, skip, stop } = useTourStore.getState();

  if (tourActive(status)) {
    const paused = status === 'paused';
    const waiting = status === 'waiting';
    return (
      <div className={styles.bar} data-testid="review-tour" data-status={status}>
        <div className={styles.row}>
          <span className={styles.label}>
            {total === 0 ? 'Tour: no stops' : `Tour: Stop ${reached} of ${total}`}
          </span>
          {/* data-phone-bar: on phones Pause · Next · Stop are in the action bar (M29-6). */}
          {!phone && (
            <span className={styles.controls} data-phone-bar>
              <button
                type="button"
                className={styles.btn}
                aria-label={paused ? 'Resume tour' : 'Pause tour'}
                disabled={waiting}
                onClick={paused ? resume : pause}
              >
                <span aria-hidden>{paused ? '▶' : '⏸'}</span>
              </button>
              <button
                type="button"
                className={`${styles.btn} ${waiting ? styles.primary : ''}`}
                data-testid="tour-next"
                onClick={next}
              >
                Next <span aria-hidden>▶</span>
              </button>
              <button type="button" className={styles.btn} aria-label="Stop tour" onClick={stop}>
                Stop
              </button>
            </span>
          )}
          <button type="button" className={styles.btn} aria-label="Skip to next stop" onClick={skip}>
            Skip <span aria-hidden>▶|</span>
          </button>
        </div>
        <SideLine />
        {waiting && card ? (
          <section
            className={styles.card}
            aria-label="Tour stop"
            data-testid="tour-stop"
            data-kind={card.kind}
            onClick={onCardClick}
          >
            <div role="status" data-testid="review-tour-text">
              <CardBody card={card} />
            </div>
            <CardControls card={card} />
          </section>
        ) : (
          <p className={styles.text} role="status" data-testid="review-tour-text">
            {text}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.bar} data-testid="review-tour" data-status={status}>
      <div className={styles.row}>
        {status === 'finished' && (
          <span role="status" data-testid="review-tour-text">
            Tour finished — browse the moves or jump to a mistake.
          </span>
        )}
        {status === 'stopped' && (
          <span role="status" data-testid="review-tour-text">
            Tour stopped.
          </span>
        )}
        <button
          type="button"
          className={styles.btn}
          data-testid="tour-replay"
          onClick={() => void start()}
        >
          Replay tour
        </button>
      </div>
      {status !== 'idle' && <SideLine />}
    </div>
  );
}
