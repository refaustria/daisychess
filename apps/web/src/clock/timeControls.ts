import type { ClockParams } from '../live/boardApi';

/** lichess speed categories (by estimated game duration). */
export type TimeCategory = 'UltraBullet' | 'Bullet' | 'Blitz' | 'Rapid' | 'Classical';
export const TIME_CATEGORIES: readonly TimeCategory[] = [
  'UltraBullet',
  'Bullet',
  'Blitz',
  'Rapid',
  'Classical',
];

export interface TimeControl {
  id: string;
  label: string;
  /** Minutes. */
  minutes: number;
  /** Seconds. */
  increment: number;
}

/** A clock setting in milliseconds (local games). */
export interface ClockSetting {
  initialMs: number;
  incrementMs: number;
}

/**
 * lichess rule: estimated duration = initial + 40 × increment (seconds); < 30 s UltraBullet,
 * < 3 min Bullet, < 8 min Blitz, < 25 min Rapid, otherwise Classical.
 */
export function timeCategory(initialMs: number, incrementMs: number): TimeCategory {
  const est = (initialMs + 40 * incrementMs) / 1000;
  if (est < 30) return 'UltraBullet';
  if (est < 180) return 'Bullet';
  if (est < 480) return 'Blitz';
  if (est < 1500) return 'Rapid';
  return 'Classical';
}

/** "5+3", "0.5+0", "0.25+0" for a time control in minutes + seconds. */
const minutesText = (minutes: number): string =>
  Number.isInteger(minutes) ? String(minutes) : String(Math.round(minutes * 100) / 100);

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
export const SEEK_TIME_CONTROLS: readonly TimeControl[] = [
  tc(10, 0),
  tc(10, 5),
  tc(15, 10),
  tc(30, 0),
  tc(30, 20),
];

/** Direct challenges and the lichess AI also allow blitz. */
export const CHALLENGE_TIME_CONTROLS: readonly TimeControl[] = [
  tc(3, 0),
  tc(3, 2),
  tc(5, 0),
  tc(5, 3),
  ...SEEK_TIME_CONTROLS,
];

export const findTimeControl = (
  id: string,
  list: readonly TimeControl[] = CHALLENGE_TIME_CONTROLS,
): TimeControl => list.find((t) => t.id === id) ?? list[0]!;

export const toClock = (t: TimeControl): ClockParams => ({
  limit: t.minutes * 60,
  increment: t.increment,
});

/** "5+3" from a clock in seconds. */
export const clockLabel = (c: { limit: number; increment: number }): string =>
  `${c.limit % 60 === 0 ? c.limit / 60 : (c.limit / 60).toFixed(1)}+${c.increment}`;

// ---------------------------------------------------------------------------------------------
// Local games (Play vs Engine)

export const toSetting = (t: Pick<TimeControl, 'minutes' | 'increment'>): ClockSetting => ({
  initialMs: Math.round(t.minutes * 60_000),
  incrementMs: Math.round(t.increment * 1000),
});

/** "3+2 · Blitz". */
export function timeControlLabel(s: ClockSetting): string {
  return `${minutesText(s.initialMs / 60_000)}+${minutesText(s.incrementMs / 1000)} · ${timeCategory(s.initialMs, s.incrementMs)}`;
}

const local = (minutes: number, increment: number): TimeControl => {
  const t = tc(minutes, increment);
  return { ...t, label: timeControlLabel(toSetting(t)) };
};

/** Presets of the local game, in category order. */
export const LOCAL_TIME_CONTROLS: readonly TimeControl[] = [
  local(1, 0),
  local(2, 1),
  local(3, 0),
  local(3, 2),
  local(5, 0),
  local(5, 3),
  local(10, 0),
  local(10, 5),
  local(15, 10),
  local(30, 0),
  local(30, 20),
];

/** Presets grouped by category (for `<optgroup>`), categories without presets left out. */
export function groupedTimeControls(
  list: readonly TimeControl[] = LOCAL_TIME_CONTROLS,
): { category: TimeCategory; list: TimeControl[] }[] {
  return TIME_CATEGORIES.map((category) => ({
    category,
    list: list.filter(
      (t) => timeCategory(toSetting(t).initialMs, toSetting(t).incrementMs) === category,
    ),
  })).filter((g) => g.list.length > 0);
}

/** Bounds of a custom local time control. */
export const CUSTOM_MINUTES = { min: 0.25, max: 180 } as const;
export const CUSTOM_INCREMENT = { min: 0, max: 60 } as const;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Clamps a custom time control to the allowed range; non-finite values fall back to the minimum. */
export function customSetting(minutes: number, increment: number): ClockSetting {
  const m = Number.isFinite(minutes)
    ? clamp(minutes, CUSTOM_MINUTES.min, CUSTOM_MINUTES.max)
    : CUSTOM_MINUTES.min;
  const i = Number.isFinite(increment)
    ? clamp(Math.round(increment), CUSTOM_INCREMENT.min, CUSTOM_INCREMENT.max)
    : 0;
  return toSetting({ minutes: m, increment: i });
}

/** Validates a stored setting: null (no clock), or a clamped setting. */
export function sanitizeSetting(raw: unknown): ClockSetting | null {
  if (!raw || typeof raw !== 'object') return null;
  const { initialMs, incrementMs } = raw as Record<string, unknown>;
  if (typeof initialMs !== 'number' || typeof incrementMs !== 'number') return null;
  return customSetting(initialMs / 60_000, incrementMs / 1000);
}

/** The preset matching `s`, if any. */
export function presetOf(
  s: ClockSetting | null,
  list: readonly TimeControl[] = LOCAL_TIME_CONTROLS,
): TimeControl | undefined {
  if (!s) return undefined;
  return list.find((t) => {
    const p = toSetting(t);
    return p.initialMs === s.initialMs && p.incrementMs === s.incrementMs;
  });
}
