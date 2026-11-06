/**
 * Progress of the endgame course (ADR-025 §6): localStorage {@link ENDGAMES_KEY}, format v1
 * `{ v: 1, lessons: Record<id, LessonProgress> }`, with the openings trainer's spaced repetition
 * (`trainer/schedule.ts`, unchanged): a clean success multiplies the interval by 2.5, anything
 * else makes the lesson due now. Parsed defensively; not mirrored to native Preferences.
 */
import {
  dueKeys,
  isDue,
  parseSchedule,
  reviewEntry,
  type KeyValueStorage,
  type Schedule,
  type ScheduleEntry,
} from '../trainer/schedule';

export const ENDGAMES_KEY = 'daisychess.endgames';
/** Lesson ids are short slugs; longer keys are dropped when parsing. */
const MAX_ID = 80;
/** Lessons kept at most (the course has 16; protects against a polluted store). */
const MAX_LESSONS = 500;

export interface LessonProgress {
  /** Solved at least once (also after a take-back or with hints). */
  done: boolean;
  /** Recorded attempts (one per try that reached a result). */
  attempts: number;
  /** Hints, shown moves and take-backs over all recorded attempts. */
  mistakes: number;
  /** Last recorded result (epoch ms). */
  lastAt: number;
  schedule: ScheduleEntry;
}

export interface EndgamesProgress {
  v: 1;
  lessons: Readonly<Record<string, LessonProgress>>;
}

export const emptyProgress = (): EndgamesProgress => ({ v: 1, lessons: {} });

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;

/** Parses the stored JSON; invalid lessons are dropped, garbage or another version gives `{}`. */
export function parseProgress(raw: string | null): EndgamesProgress {
  if (!raw) return emptyProgress();
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return emptyProgress();
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return emptyProgress();
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || typeof o.lessons !== 'object' || o.lessons === null) return emptyProgress();
  if (Array.isArray(o.lessons)) return emptyProgress();
  const lessons: Record<string, LessonProgress> = {};
  let n = 0;
  for (const [id, e] of Object.entries(o.lessons as Record<string, unknown>)) {
    if (n >= MAX_LESSONS) break;
    if (id.length === 0 || id.length > MAX_ID || typeof e !== 'object' || e === null) continue;
    const p = e as Record<string, unknown>;
    // The schedule entry goes through the trainer's own defensive parser.
    const schedule = parseSchedule(JSON.stringify({ s: p.schedule }))['s'];
    if (!schedule) continue;
    lessons[id] = {
      done: p.done === true,
      attempts: count(p.attempts),
      mistakes: count(p.mistakes),
      lastAt: count(p.lastAt),
      schedule,
    };
    n++;
  }
  return { v: 1, lessons };
}

export function serializeProgress(p: EndgamesProgress): string {
  return JSON.stringify(p);
}

/** localStorage, or a fake in tests. */
export interface ProgressStorage extends KeyValueStorage {
  removeItem?(key: string): void;
}

const defaultStorage = (): ProgressStorage | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined; // access denied (privacy settings)
  }
};

export function loadProgress(storage = defaultStorage()): EndgamesProgress {
  try {
    return parseProgress(storage?.getItem(ENDGAMES_KEY) ?? null);
  } catch {
    return emptyProgress();
  }
}

const listeners = new Set<(p: EndgamesProgress) => void>();

/** Called after every save and reset (the lesson store follows Settings → Reset). */
export function subscribeProgress(fn: (p: EndgamesProgress) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function saveProgress(p: EndgamesProgress, storage = defaultStorage()): void {
  try {
    storage?.setItem(ENDGAMES_KEY, serializeProgress(p));
  } catch {
    // Storage full or blocked: the progress lives on for this session only.
  }
  for (const fn of [...listeners]) fn(p);
}

/** Settings → "Reset endgame progress". */
export function resetEndgameProgress(storage = defaultStorage()): void {
  try {
    storage?.removeItem?.(ENDGAMES_KEY);
  } catch {
    // Blocked: nothing stored either.
  }
  const p = emptyProgress();
  for (const fn of [...listeners]) fn(p);
}

export interface AttemptResult {
  success: boolean;
  /** Hints, shown moves and take-backs of the attempt. */
  mistakes: number;
  now: number;
}

/**
 * Records the result of one attempt: a success without any mistake grows the interval, anything
 * else makes the lesson due now (ADR-025 §6).
 */
export function recordAttempt(
  p: EndgamesProgress,
  id: string,
  { success, mistakes, now }: AttemptResult,
): EndgamesProgress {
  const prev = p.lessons[id];
  const clean = success && mistakes === 0;
  const entry: LessonProgress = {
    done: (prev?.done ?? false) || success,
    attempts: (prev?.attempts ?? 0) + 1,
    mistakes: (prev?.mistakes ?? 0) + Math.max(0, Math.floor(mistakes)),
    lastAt: now,
    schedule: reviewEntry(prev?.schedule, clean, now, mistakes),
  };
  return { v: 1, lessons: { ...p.lessons, [id]: entry } };
}

/**
 * A success later in an already recorded attempt (after a take-back): the lesson counts as done,
 * the schedule keeps the recorded failure.
 */
export function markDone(p: EndgamesProgress, id: string, now: number): EndgamesProgress {
  const prev = p.lessons[id];
  if (!prev || prev.done) return p;
  return { v: 1, lessons: { ...p.lessons, [id]: { ...prev, done: true, lastAt: now } } };
}

/** The schedules by lesson id. */
export function lessonSchedule(p: EndgamesProgress): Schedule {
  return Object.fromEntries(Object.entries(p.lessons).map(([id, e]) => [id, e.schedule]));
}

/**
 * Due lessons, earliest due first, restricted to `known` ids (lessons removed from the course
 * are ignored).
 */
export function dueLessons(p: EndgamesProgress, now: number, known: readonly string[]): string[] {
  const ids = new Set(known);
  return dueKeys(lessonSchedule(p), now).filter((id) => ids.has(id));
}

export type LessonMark = 'new' | 'done' | 'due' | 'tried';

/**
 * The mark of a lesson in the course list: `new` (never tried), `due` (tried and due again),
 * `done` (solved and not due), `tried` (not solved yet, not due — cannot happen with the current
 * schedule, kept for safety).
 */
export function lessonMark(p: EndgamesProgress, id: string, now: number): LessonMark {
  const e = p.lessons[id];
  if (!e) return 'new';
  if (isDue(e.schedule, now)) return 'due';
  return e.done ? 'done' : 'tried';
}
