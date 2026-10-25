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

  it('skip jumps to the next notable step, then to the end', () => {
    const { c, steps, statuses } = setup();
    c.start();
    c.skip();
    expect(steps).toEqual([1, 2]);
    c.skip();
    expect(steps).toEqual([1, 2, 4]);
    c.skip();
    expect(steps).toEqual([1, 2, 4, 5]);
    expect(statuses.at(-1)).toBe('finished');
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
