import type { Orientation } from '../store/gameStore';
import styles from './Clock.module.css';
import { formatClock, isLowTime } from './format';

export type ClockState = 'idle' | 'active' | 'running' | 'flagged';

export interface ClockProps {
  /** Remaining time in ms. */
  ms: number;
  side: Orientation;
  /**
   * `active`: this side is to move (highlighted, not ticking yet), `running`: ticking (pulse),
   * `flagged`: out of time.
   */
  state?: ClockState;
  /** Initial time of the game (for the low-time threshold). */
  initialMs?: number;
  testId?: string;
  className?: string;
}

const SIDE = { white: 'White', black: 'Black' } as const;

/**
 * A player's clock: m:ss, tenths under 10 s, h:mm:ss from an hour. `role="timer"` with
 * `aria-live="off"` (screen readers read it on demand: "White clock 9:58").
 */
export function Clock({ ms, side, state = 'idle', initialMs, testId, className }: ClockProps) {
  const text = formatClock(ms);
  const flagged = state === 'flagged';
  const active = state === 'active' || state === 'running';
  const cls = [
    styles.clock,
    active ? styles.clockActive : '',
    state === 'running' ? styles.clockRunning : '',
    isLowTime(ms, initialMs) ? styles.clockLow : '',
    flagged ? styles.clockFlagged : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cls}
      role="timer"
      aria-live="off"
      aria-label={`${SIDE[side]} clock ${text}${flagged ? ' (flagged)' : ''}`}
      data-testid={testId}
      data-active={active || undefined}
      data-state={flagged ? 'flagged' : state}
    >
      {text}
    </div>
  );
}
