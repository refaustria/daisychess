import type { ClockSetting } from './timeControls';

export type ClockSide = 'w' | 'b';

/**
 * A two-sided chess clock (Fischer increment), as plain data. Time is measured with a monotonic
 * source (`performance.now()` in the app): every transition first charges the running side with
 * the time since `lastTickAt`, so a throttled timer (background tab) only delays the display and
 * the flag detection, it never loses or adds time.
 */
export interface GameClock {
  /** Remaining ms of White / Black as of `lastTickAt`. */
  w: number;
  b: number;
  /** The side whose time runs, null when stopped. */
  runningSide: ClockSide | null;
  /** Monotonic timestamp (ms) the remaining times refer to. */
  lastTickAt: number;
  /** The side that ran out of time (the clock is stopped then). */
  flagged: ClockSide | null;
  initialMs: number;
  incrementMs: number;
}

export const otherSide = (s: ClockSide): ClockSide => (s === 'w' ? 'b' : 'w');

export function createClock(setting: ClockSetting, now: number): GameClock {
  return {
    w: setting.initialMs,
    b: setting.initialMs,
    runningSide: null,
    lastTickAt: now,
    flagged: null,
    initialMs: setting.initialMs,
    incrementMs: setting.incrementMs,
  };
}

/** Remaining ms of `side` at `now` (without changing the clock). */
export function remainingAt(c: GameClock, side: ClockSide, now: number): number {
  const base = c[side];
  if (c.runningSide !== side) return Math.max(0, base);
  return Math.max(0, base - Math.max(0, now - c.lastTickAt));
}

/**
 * Charges the running side with the time since the last tick. Reaching 0 flags that side and
 * stops the clock. Returns the same object when nothing changed in a stopped clock.
 */
export function tick(c: GameClock, now: number): GameClock {
  const side = c.runningSide;
  if (side === null) return c.lastTickAt === now ? c : { ...c, lastTickAt: now };
  const left = remainingAt(c, side, now);
  if (left <= 0) return { ...c, [side]: 0, runningSide: null, flagged: side, lastTickAt: now };
  return { ...c, [side]: left, lastTickAt: now };
}

/** Starts the clock of `side` (or stops both with null), charging the previous side first. */
export function runSide(c: GameClock, side: ClockSide | null, now: number): GameClock {
  const t = tick(c, now);
  if (t.flagged) return t;
  return t.runningSide === side ? t : { ...t, runningSide: side };
}

/**
 * `mover` completed a move: charge the elapsed time, add the increment to the mover (Fischer)
 * and start the opponent's clock. A mover who was already out of time is flagged instead.
 */
export function afterMove(c: GameClock, mover: ClockSide, now: number): GameClock {
  const t = tick(c, now);
  if (t.flagged) return t;
  return { ...t, [mover]: t[mover] + t.incrementMs, runningSide: otherSide(mover) };
}

/** Engine search time never below this (ms). */
export const MIN_ENGINE_MOVE_MS = 50;

/**
 * Thinking time of the engine with a clock: `min(configured, max(50 ms, remaining/30 +
 * 0.8 × increment))`, where the increment share is capped at half the remaining time (with
 * 1 s left and a 2 s increment the plain formula would flag before the increment is added).
 * With remaining/30 per move the engine keeps a geometric reserve (after n moves (29/30)^n of
 * its time is left, plus the increments), so even at full strength it does not flag itself.
 */
export function engineMoveTime(
  configuredMs: number,
  remainingMs: number,
  incrementMs: number,
): number {
  const left = Math.max(0, remainingMs);
  const budget = Math.max(MIN_ENGINE_MOVE_MS, Math.min(left / 30 + incrementMs * 0.8, left / 2));
  return Math.round(Math.min(configuredMs, budget));
}
