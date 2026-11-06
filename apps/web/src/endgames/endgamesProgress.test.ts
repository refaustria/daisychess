import { describe, expect, it, vi } from 'vitest';
import { DAY_MS } from '../trainer/schedule';
import {
  dueLessons,
  emptyProgress,
  ENDGAMES_KEY,
  lessonMark,
  lessonSchedule,
  loadProgress,
  markDone,
  parseProgress,
  recordAttempt,
  resetEndgameProgress,
  saveProgress,
  serializeProgress,
  subscribeProgress,
  type ProgressStorage,
} from './endgamesProgress';

const NOW = 1_700_000_000_000;

function memory(
  init: Record<string, string> = {},
): ProgressStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('parseProgress', () => {
  it('garbage, other versions and wrong shapes give an empty v1 record', () => {
    for (const raw of [
      null,
      '',
      'nope',
      '[]',
      '{"v":2,"lessons":{}}',
      '{"v":1,"lessons":[]}',
      '1',
    ]) {
      expect(parseProgress(raw)).toEqual(emptyProgress());
    }
  });

  it('keeps valid lessons and drops invalid ones', () => {
    const ok = { due: NOW, interval: 1, lapses: 0, successes: 1 };
    const raw = JSON.stringify({
      v: 1,
      lessons: {
        'kq-vs-k': { done: true, attempts: 2, mistakes: 1.7, lastAt: NOW, schedule: ok },
        broken: { done: true, attempts: 1, mistakes: 0, lastAt: NOW, schedule: { due: -1 } },
        [`x${'y'.repeat(100)}`]: { done: true, schedule: ok },
        weird: { done: 'yes', attempts: -3, mistakes: 'a', lastAt: null, schedule: ok },
      },
    });
    const p = parseProgress(raw);
    expect(Object.keys(p.lessons).sort()).toEqual(['kq-vs-k', 'weird']);
    expect(p.lessons['kq-vs-k']).toEqual({
      done: true,
      attempts: 2,
      mistakes: 1,
      lastAt: NOW,
      schedule: ok,
    });
    expect(p.lessons['weird']).toMatchObject({ done: false, attempts: 0, mistakes: 0, lastAt: 0 });
  });

  it('round-trips through serializeProgress', () => {
    const p = recordAttempt(emptyProgress(), 'lucena', { success: true, mistakes: 0, now: NOW });
    expect(parseProgress(serializeProgress(p))).toEqual(p);
  });
});

describe('recordAttempt and markDone', () => {
  it('a clean success grows the interval; a success with mistakes or a failure is due now', () => {
    let p = recordAttempt(emptyProgress(), 'a', { success: true, mistakes: 0, now: NOW });
    expect(p.lessons['a']).toMatchObject({ done: true, attempts: 1, mistakes: 0, lastAt: NOW });
    expect(p.lessons['a']!.schedule).toMatchObject({
      interval: 1,
      due: NOW + DAY_MS,
      successes: 1,
    });
    p = recordAttempt(p, 'a', { success: true, mistakes: 0, now: NOW + DAY_MS });
    expect(p.lessons['a']!.schedule.interval).toBe(2.5);

    const hinted = recordAttempt(p, 'a', { success: true, mistakes: 2, now: NOW + 2 * DAY_MS });
    expect(hinted.lessons['a']).toMatchObject({ done: true, attempts: 3, mistakes: 2 });
    expect(hinted.lessons['a']!.schedule).toMatchObject({ due: NOW + 2 * DAY_MS, lapses: 1 });

    const failed = recordAttempt(emptyProgress(), 'b', { success: false, mistakes: 0, now: NOW });
    expect(failed.lessons['b']).toMatchObject({ done: false, attempts: 1 });
    expect(failed.lessons['b']!.schedule.due).toBe(NOW);
  });

  it('markDone sets done without touching the schedule', () => {
    const failed = recordAttempt(emptyProgress(), 'b', { success: false, mistakes: 1, now: NOW });
    const done = markDone(failed, 'b', NOW + 5);
    expect(done.lessons['b']).toMatchObject({ done: true, lastAt: NOW + 5 });
    expect(done.lessons['b']!.schedule).toEqual(failed.lessons['b']!.schedule);
    expect(markDone(done, 'b', NOW + 9)).toBe(done);
    expect(markDone(done, 'unknown', NOW)).toBe(done);
  });
});

describe('due lessons and marks', () => {
  it('lists the due lessons of the course, earliest first, and marks each lesson', () => {
    let p = emptyProgress();
    p = recordAttempt(p, 'late', { success: false, mistakes: 0, now: NOW });
    p = recordAttempt(p, 'early', { success: false, mistakes: 0, now: NOW - 10 });
    p = recordAttempt(p, 'clean', { success: true, mistakes: 0, now: NOW });
    p = recordAttempt(p, 'removed', { success: false, mistakes: 0, now: NOW - 99 });
    const course = ['clean', 'early', 'late', 'fresh'];
    expect(dueLessons(p, NOW, course)).toEqual(['early', 'late']);
    expect(Object.keys(lessonSchedule(p))).toHaveLength(4);
    expect(lessonMark(p, 'fresh', NOW)).toBe('new');
    expect(lessonMark(p, 'late', NOW)).toBe('due');
    expect(lessonMark(p, 'clean', NOW)).toBe('done');
    expect(lessonMark(p, 'clean', NOW + DAY_MS)).toBe('due');
  });
});

describe('storage', () => {
  it('save, load, reset and the listeners', () => {
    const storage = memory();
    const seen = vi.fn();
    const off = subscribeProgress(seen);
    const p = recordAttempt(emptyProgress(), 'a', { success: true, mistakes: 0, now: NOW });
    saveProgress(p, storage);
    expect(JSON.parse(storage.data.get(ENDGAMES_KEY)!).v).toBe(1);
    expect(loadProgress(storage)).toEqual(p);
    expect(seen).toHaveBeenLastCalledWith(p);
    resetEndgameProgress(storage);
    expect(storage.data.has(ENDGAMES_KEY)).toBe(false);
    expect(seen).toHaveBeenLastCalledWith(emptyProgress());
    off();
    saveProgress(p, storage);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('blocked storage is survived', () => {
    const blocked: ProgressStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadProgress(blocked)).toEqual(emptyProgress());
    expect(() => saveProgress(emptyProgress(), blocked)).not.toThrow();
    expect(() => resetEndgameProgress(blocked)).not.toThrow();
    expect(loadProgress(undefined)).toEqual(emptyProgress());
  });
});
