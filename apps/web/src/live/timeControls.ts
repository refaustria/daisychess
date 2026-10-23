import type { ClockParams } from './boardApi';

export interface TimeControl {
  id: string;
  label: string;
  /** Minutes. */
  minutes: number;
  /** Seconds. */
  increment: number;
}

const tc = (minutes: number, increment: number): TimeControl => ({
  id: `${minutes}+${increment}`,
  label: `${minutes}+${increment}`,
  minutes,
  increment,
});

/**
 * Lobby seeks through the Board API are limited to Rapid, Classical and Correspondence
 * (lichess API docs, Board → Restrictions); blitz is only possible in direct challenges and
 * games against the AI.
 */
export const SEEK_TIME_CONTROLS: readonly TimeControl[] = [tc(10, 0), tc(10, 5), tc(15, 10), tc(30, 0), tc(30, 20)];

/** Direct challenges and the lichess AI also allow blitz. */
export const CHALLENGE_TIME_CONTROLS: readonly TimeControl[] = [
  tc(3, 0),
  tc(3, 2),
  tc(5, 0),
  tc(5, 3),
  ...SEEK_TIME_CONTROLS,
];

export const findTimeControl = (id: string, list: readonly TimeControl[] = CHALLENGE_TIME_CONTROLS): TimeControl =>
  list.find((t) => t.id === id) ?? list[0]!;

export const toClock = (t: TimeControl): ClockParams => ({ limit: t.minutes * 60, increment: t.increment });

/** "5+3" from a clock in seconds. */
export const clockLabel = (c: { limit: number; increment: number }): string =>
  `${c.limit % 60 === 0 ? c.limit / 60 : (c.limit / 60).toFixed(1)}+${c.increment}`;
