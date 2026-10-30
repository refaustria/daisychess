import { describe, expect, it, vi } from 'vitest';
import { buildMoveDetails } from './details';
import { gameToBatch } from './reviewStore';
import { scholarSummary } from './testFixtures';
import { useGameStore } from '../store/gameStore';
import {
  buildSchedule,
  highlightText,
  LONG_DWELL_MS,
  SHORT_DWELL_MS,
  stopNumber,
  TourController,
  tourKind,
  type TourStatus,
  type TourStep,
} from './tour';

describe('schedule', () => {
  it('marks blunders, mistakes and the punishing best move; skips inaccuracies', () => {
    const s = buildSchedule(scholarSummary());
    expect(s.map((x) => x.kind ?? null)).toEqual([
      null,
      null,
      null,
      null,
      null,
      'blunder',
      'great',
    ]);
  });

  it('stops at the book end and at the user side\'s mistakes/blunders only', () => {
    const summary = scholarSummary();
    // Black's blunder 3... Nf6 (ply 6): a stop for Black, a long-dwell highlight for White.
    const black = buildSchedule(summary, { userSide: 'black', lastBookPly: 4 });
    expect(black.map((x) => x.stop ?? null)).toEqual([
      null,
      null,
      null,
      'opening',
      null,
      'mistake',
      null,
    ]);
    expect(black[5]!.kind).toBe('blunder');
    const white = buildSchedule(summary, { userSide: 'white', lastBookPly: 4 });
    expect(white.filter((x) => x.stop).map((x) => x.ply)).toEqual([4]);
    expect(white[5]).toEqual({ ply: 6, kind: 'blunder' });
    // Inaccuracies are no stops.
    expect(white[4]!.stop).toBeUndefined();
    // Without a side: no mistake stops (the M20-2 schedule).
    expect(buildSchedule(summary).some((x) => x.stop)).toBe(false);
  });

  it('has no opening stop without book moves or from a custom start position', () => {
    const summary = scholarSummary();
    expect(buildSchedule(summary, { userSide: 'white', lastBookPly: 0 }).some((x) => x.stop)).toBe(
      false,
    );
    const custom = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
    expect(
      buildSchedule(summary, { lastBookPly: 4, startFen: custom }).some((x) => x.stop),
    ).toBe(false);
    const standard = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(buildSchedule(summary, { lastBookPly: 4, startFen: standard })[3]!.stop).toBe(
      'opening',
    );
  });

  it('the opening stop wins when a book move is also a mistake of the user', () => {
    const summary = scholarSummary();
    const s = buildSchedule(summary, { userSide: 'black', lastBookPly: 6 });
    expect(s[5]!.stop).toBe('opening');
    expect(s.filter((x) => x.stop)).toHaveLength(1);
  });

  it('counts stops for the progress', () => {
    const s = buildSchedule(scholarSummary(), { userSide: 'black', lastBookPly: 4 });
    expect([0, 3, 4, 5, 6].map((i) => stopNumber(s, i))).toEqual([0, 1, 1, 2, 2]);
    expect(stopNumber(s, -1)).toBe(0);
  });

  it('does not mark a best move after a small loss or by the same side', () => {
    const [a, b] = scholarSummary().moves.slice(4, 6);
    expect(tourKind({ ...b!, classification: 'best' }, a)).toBeUndefined();
    expect(tourKind({ ...a!, classification: 'best' }, { ...a!, winProbLoss: 50 })).toBeUndefined();
  });

  it('formats a highlight text with the better move', () => {
    useGameStore.getState().loadPgn('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#');
    const details = buildMoveDetails(
      scholarSummary(),
      gameToBatch(useGameStore.getState()),
      Array.from({ length: 8 }, () => ({})),
    );
    expect(highlightText(details, { ply: 6, kind: 'blunder' })).toMatch(
      /^3\.\.\. Nf6\?\? Blunder \(.+\): better was g6$/,
    );
    expect(highlightText(details, { ply: 7, kind: 'great' })).toContain('Great move');
    expect(highlightText(details, { ply: 99, kind: 'great' })).toBe('');
    expect(highlightText(details, { ply: 6, kind: 'blunder' }, new Set([6]))).toMatch(
      /^3\.\.\. Nf6\?\? Blunder \(.+\): better was g6 \(in time trouble\)$/,
    );
    expect(highlightText(details, { ply: 6, kind: 'blunder' }, new Set([5]))).not.toContain(
      'time trouble',
    );
  });
});

function manualTimer() {
  let pending: { fn: () => void; ms: number } | undefined;
  return {
    timer: {
      set: (fn: () => void, ms: number) => (pending = { fn, ms }),
      clear: (h: unknown) => {
        if (pending === h) pending = undefined;
      },
    },
    get ms() {
      return pending?.ms;
    },
    fire() {
      const p = pending;
      pending = undefined;
      p?.fn();
    },
  };
}

const SCHEDULE: TourStep[] = [
  { ply: 1 },
  { ply: 2, kind: 'mistake' },
  { ply: 3 },
  { ply: 4, kind: 'blunder' },
  { ply: 5 },
];

/** Opening stop on ply 2, an opponent blunder on ply 4 (no stop), the user's mistake on ply 6. */
const STOPS: TourStep[] = [
  { ply: 1 },
  { ply: 2, stop: 'opening' },
  { ply: 3 },
  { ply: 4, kind: 'blunder' },
  { ply: 5 },
  { ply: 6, kind: 'mistake', stop: 'mistake' },
  { ply: 7 },
];

function setup(schedule = SCHEDULE) {
  const t = manualTimer();
  const steps: number[] = [];
  const statuses: TourStatus[] = [];
  const c = new TourController(
    schedule,
    { onStep: (s) => steps.push(s.ply), onStatus: (s) => statuses.push(s) },
    t.timer,
  );
  return { c, t, steps, statuses };
}

describe('TourController', () => {
  it('steps with short and long dwells and finishes on the last ply', () => {
    const { c, t, steps, statuses } = setup();
    c.start();
    expect(steps).toEqual([1]);
    expect(t.ms).toBe(SHORT_DWELL_MS);
    t.fire();
    expect(steps).toEqual([1, 2]);
    expect(t.ms).toBe(LONG_DWELL_MS);
    t.fire();
    t.fire();
    t.fire();
    expect(steps).toEqual([1, 2, 3, 4, 5]);
    t.fire();
    expect(statuses).toEqual(['playing', 'finished']);
    expect(t.ms).toBeUndefined();
  });

  it('works with real fake timers', () => {
    vi.useFakeTimers();
    const steps: number[] = [];
    const c = new TourController(SCHEDULE, {
      onStep: (s) => steps.push(s.ply),
      onStatus: () => {},
    });
    c.start();
    vi.advanceTimersByTime(SHORT_DWELL_MS);
    expect(steps).toEqual([1, 2]);
    vi.advanceTimersByTime(LONG_DWELL_MS - 1);
    expect(steps).toEqual([1, 2]);
    vi.advanceTimersByTime(1);
    expect(steps).toEqual([1, 2, 3]);
    c.stop();
    vi.advanceTimersByTime(10_000);
    expect(steps).toEqual([1, 2, 3]);
    vi.useRealTimers();
  });

  it('pauses and resumes with a fresh dwell', () => {
    const { c, t, steps } = setup();
    c.start();
    c.pause();
    expect(c.state.status).toBe('paused');
    expect(t.ms).toBeUndefined();
    c.resume();
    expect(c.state.status).toBe('playing');
    t.fire();
    expect(steps).toEqual([1, 2]);
  });

  it('next() advances manually, also while paused', () => {
    const { c, steps } = setup();
    c.start();
    c.pause();
    c.next();
    expect(steps).toEqual([1, 2]);
    expect(c.state.status).toBe('paused');
  });

  it('skip without stops goes to the last step and finishes', () => {
    const { c, steps, statuses } = setup();
    c.start();
    c.skip();
    expect(steps).toEqual([1, 5]);
    expect(statuses.at(-1)).toBe('finished');
  });

  it('waits at a stop with no timer armed; next continues and auto-advances again', () => {
    const { c, t, steps, statuses } = setup(STOPS);
    c.start();
    t.fire();
    expect(steps).toEqual([1, 2]);
    expect(c.state.status).toBe('waiting');
    expect(t.ms).toBeUndefined();
    c.next();
    expect(steps).toEqual([1, 2, 3]);
    expect(c.state.status).toBe('playing');
    expect(t.ms).toBe(SHORT_DWELL_MS);
    t.fire();
    // The opponent's blunder: long dwell, never a wait.
    expect(steps).toEqual([1, 2, 3, 4]);
    expect(c.state.status).toBe('playing');
    expect(t.ms).toBe(LONG_DWELL_MS);
    t.fire();
    t.fire();
    expect(steps).toEqual([1, 2, 3, 4, 5, 6]);
    expect(c.state.status).toBe('waiting');
    expect(t.ms).toBeUndefined();
    c.next();
    t.fire();
    expect(statuses).toEqual(['playing', 'waiting', 'playing', 'waiting', 'playing', 'finished']);
  });

  it('waits with real fake timers for as long as it takes', () => {
    vi.useFakeTimers();
    const steps: number[] = [];
    const c = new TourController(STOPS, { onStep: (s) => steps.push(s.ply), onStatus: () => {} });
    c.start();
    vi.advanceTimersByTime(60_000);
    expect(steps).toEqual([1, 2]);
    expect(c.state.status).toBe('waiting');
    c.next();
    vi.advanceTimersByTime(SHORT_DWELL_MS);
    expect(steps).toEqual([1, 2, 3, 4]);
    c.stop();
    vi.useRealTimers();
  });

  it('pause is a no-op and resume is next while waiting', () => {
    const { c, t, steps } = setup(STOPS);
    c.start();
    t.fire();
    c.pause();
    expect(c.state.status).toBe('waiting');
    c.resume();
    expect(steps).toEqual([1, 2, 3]);
    expect(c.state.status).toBe('playing');
  });

  it('skip lands on the next stop (not the next highlight) and waits there', () => {
    const { c, t, steps, statuses } = setup(STOPS);
    c.start();
    c.skip();
    expect(steps).toEqual([1, 2]);
    expect(c.state.status).toBe('waiting');
    c.skip();
    expect(steps).toEqual([1, 2, 6]);
    expect(c.state.status).toBe('waiting');
    expect(t.ms).toBeUndefined();
    c.skip();
    expect(steps).toEqual([1, 2, 6, 7]);
    expect(statuses.at(-1)).toBe('finished');
  });

  it('a paused tour stepped onto a stop waits; a stop on the last step finishes on next', () => {
    const { c, steps } = setup([{ ply: 1 }, { ply: 2, stop: 'mistake' }]);
    c.start();
    c.pause();
    c.next();
    expect(steps).toEqual([1, 2]);
    expect(c.state.status).toBe('waiting');
    c.next();
    expect(c.state.status).toBe('finished');
  });

  it('a stop on the first step waits at once; stop ends a waiting tour', () => {
    const { c, t } = setup([{ ply: 1, stop: 'opening' }, { ply: 2 }]);
    c.start();
    expect(c.state.status).toBe('waiting');
    expect(t.ms).toBeUndefined();
    c.stop();
    expect(c.state.status).toBe('stopped');
    c.next();
    expect(c.state.status).toBe('stopped');
  });

  it('stop ends the tour and ignores further commands', () => {
    const { c, t, steps } = setup();
    c.start();
    c.stop();
    expect(c.state.status).toBe('stopped');
    c.next();
    c.resume();
    c.skip();
    expect(steps).toEqual([1]);
    expect(t.ms).toBeUndefined();
  });

  it('an empty schedule finishes at once', () => {
    const { c } = setup([]);
    c.start();
    expect(c.state.status).toBe('finished');
  });
});
