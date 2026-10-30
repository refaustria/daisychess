import type { MouseEvent } from 'react';
import { tourActive, type TourCard } from '../../review/tour';
import { useTourStore } from '../../review/tourStore';
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
      </>
    );
  }
  return <p className={styles.para}>{card.text}</p>;
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
