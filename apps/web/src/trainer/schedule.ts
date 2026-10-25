/**
 * Spaced repetition for the openings drill (SM-2 light), pure.
 *
 * Per variation (key `openingKey` = ECO + name) one {@link ScheduleEntry}. A drill without a
 * mistake multiplies the interval by {@link GROWTH} (at least one day); a drill with a mistake
 * makes the variation due now with an interval of one day. Persisted in localStorage
 * {@link TRAINER_KEY}.
 */

export interface ScheduleEntry {
  /** When the variation is due again (epoch ms). */
  due: number;
  /** Current interval in days. */
  interval: number;
  /** Drills with at least one mistake. */
  lapses: number;
  /** Drills right first try. */
  successes: number;
}

export type Schedule = Readonly<Record<string, ScheduleEntry>>;

export const TRAINER_KEY = 'chesslab.trainer';
export const DAY_MS = 86_400_000;
export const GROWTH = 2.5;
/** Upper bound of an interval (days), so a stored value never overflows a date. */
export const MAX_INTERVAL_DAYS = 3650;
/** Entries kept at most (oldest due dropped first); keeps the stored JSON small. */
export const MAX_ENTRIES = 5000;

/** The entry after one drill of the variation: `success` = no mistake. */
export function reviewEntry(
  prev: ScheduleEntry | undefined,
  success: boolean,
  now: number,
): ScheduleEntry {
  const base = prev ?? { due: now, interval: 0, lapses: 0, successes: 0 };
  if (!success) {
    return { due: now, interval: 1, lapses: base.lapses + 1, successes: base.successes };
  }
  const interval = Math.min(MAX_INTERVAL_DAYS, Math.max(1, base.interval * GROWTH));
  return {
    due: now + interval * DAY_MS,
    interval,
    lapses: base.lapses,
    successes: base.successes + 1,
  };
}

/** Records one drill result. Returns a new schedule (the input is not changed). */
export function recordResult(
  schedule: Schedule,
  key: string,
  success: boolean,
  now: number,
): Schedule {
  return { ...schedule, [key]: reviewEntry(schedule[key], success, now) };
}

export const isDue = (e: ScheduleEntry, now: number): boolean => e.due <= now;

/** Keys of the due variations, earliest due first (ties by key). */
export function dueKeys(schedule: Schedule, now: number): string[] {
  return Object.entries(schedule)
    .filter(([, e]) => isDue(e, now))
    .sort(([ka, a], [kb, b]) => a.due - b.due || ka.localeCompare(kb))
    .map(([k]) => k);
}

const finiteNonNeg = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Parses the stored JSON defensively: invalid entries are dropped, garbage yields `{}`. */
export function parseSchedule(raw: string | null): Schedule {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out: Record<string, ScheduleEntry> = {};
  for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
    if (k.length > 300 || typeof e !== 'object' || e === null) continue;
    const o = e as Record<string, unknown>;
    if (
      !finiteNonNeg(o.due) ||
      !finiteNonNeg(o.interval) ||
      !finiteNonNeg(o.lapses) ||
      !finiteNonNeg(o.successes)
    ) {
      continue;
    }
    out[k] = {
      due: o.due,
      interval: Math.min(MAX_INTERVAL_DAYS, o.interval),
      lapses: Math.floor(o.lapses),
      successes: Math.floor(o.successes),
    };
  }
  return out;
}

/** JSON for storage, capped at {@link MAX_ENTRIES} (the entries due last are dropped). */
export function serializeSchedule(schedule: Schedule): string {
  let entries = Object.entries(schedule);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.sort(([, a], [, b]) => a.due - b.due).slice(0, MAX_ENTRIES);
  }
  return JSON.stringify(Object.fromEntries(entries));
}

/** Minimal storage surface (localStorage in the app, a fake in tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadSchedule(storage: KeyValueStorage | undefined): Schedule {
  try {
    return parseSchedule(storage?.getItem(TRAINER_KEY) ?? null);
  } catch {
    return {}; // storage blocked
  }
}

export function saveSchedule(storage: KeyValueStorage | undefined, schedule: Schedule): void {
  try {
    storage?.setItem(TRAINER_KEY, serializeSchedule(schedule));
  } catch {
    // Storage full or blocked: the schedule lives on for this session only.
  }
}
