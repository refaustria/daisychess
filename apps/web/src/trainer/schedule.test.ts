import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  dueKeys,
  isDue,
  loadSchedule,
  MAX_ENTRIES,
  MAX_INTERVAL_DAYS,
  parseSchedule,
  recordResult,
  reviewEntry,
  saveSchedule,
  serializeSchedule,
  TRAINER_KEY,
  type KeyValueStorage,
  type Schedule,
} from './schedule';

const NOW = 1_700_000_000_000;

function memoryStorage(init: Record<string, string> = {}): KeyValueStorage & {
  data: Record<string, string>;
} {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('reviewEntry', () => {
  it('first success: interval 1 day', () => {
    expect(reviewEntry(undefined, true, NOW)).toEqual({
      due: NOW + DAY_MS,
      interval: 1,
      lapses: 0,
      successes: 1,
    });
  });

  it('successes grow the interval by 2.5', () => {
    let e = reviewEntry(undefined, true, NOW);
    e = reviewEntry(e, true, NOW);
    expect(e.interval).toBe(2.5);
    expect(e.due).toBe(NOW + 2.5 * DAY_MS);
    e = reviewEntry(e, true, NOW);
    expect(e.interval).toBe(6.25);
    expect(e.successes).toBe(3);
  });

  it('a mistake makes it due now with interval 1 day', () => {
    let e = reviewEntry(undefined, true, NOW);
    e = reviewEntry(e, true, NOW);
    e = reviewEntry(e, false, NOW + 5);
    expect(e).toEqual({ due: NOW + 5, interval: 1, lapses: 1, successes: 2 });
    expect(isDue(e, NOW + 5)).toBe(true);
    // Right again afterwards: back to 2.5 days.
    expect(reviewEntry(e, true, NOW).interval).toBe(2.5);
  });

  it('a first drill with a mistake is due now', () => {
    expect(reviewEntry(undefined, false, NOW)).toEqual({
      due: NOW,
      interval: 1,
      lapses: 1,
      successes: 0,
    });
  });

  it('caps the interval', () => {
    const e = reviewEntry(
      { due: 0, interval: MAX_INTERVAL_DAYS, lapses: 0, successes: 9 },
      true,
      0,
    );
    expect(e.interval).toBe(MAX_INTERVAL_DAYS);
  });
});

describe('recordResult / dueKeys', () => {
  it('records immutably and lists due keys earliest first', () => {
    const empty: Schedule = {};
    const a = recordResult(empty, 'C50 Italian Game', false, NOW - 10);
    expect(empty).toEqual({});
    const b = recordResult(a, 'C60 Ruy Lopez', false, NOW - 20);
    const c = recordResult(b, 'B20 Sicilian Defense', true, NOW);
    expect(dueKeys(c, NOW)).toEqual(['C60 Ruy Lopez', 'C50 Italian Game']);
    expect(dueKeys(c, NOW + DAY_MS)).toEqual([
      'C60 Ruy Lopez',
      'C50 Italian Game',
      'B20 Sicilian Defense',
    ]);
    expect(dueKeys({}, NOW)).toEqual([]);
  });
});

describe('parse / serialize / storage', () => {
  it('round-trips', () => {
    const s = recordResult({}, 'C50 Italian Game', true, NOW);
    expect(parseSchedule(serializeSchedule(s))).toEqual(s);
  });

  it('drops garbage defensively', () => {
    expect(parseSchedule(null)).toEqual({});
    expect(parseSchedule('not json')).toEqual({});
    expect(parseSchedule('[1,2]')).toEqual({});
    expect(parseSchedule('"x"')).toEqual({});
    const raw = JSON.stringify({
      good: { due: 1, interval: 2, lapses: 0, successes: 1 },
      neg: { due: -1, interval: 2, lapses: 0, successes: 1 },
      str: { due: '1', interval: 2, lapses: 0, successes: 1 },
      nul: null,
      huge: { due: 1, interval: 1e12, lapses: 1.7, successes: 2.2 },
    });
    expect(parseSchedule(raw)).toEqual({
      good: { due: 1, interval: 2, lapses: 0, successes: 1 },
      huge: { due: 1, interval: MAX_INTERVAL_DAYS, lapses: 1, successes: 2 },
    });
  });

  it('caps the number of stored entries', () => {
    const big: Record<
      string,
      { due: number; interval: number; lapses: number; successes: number }
    > = {};
    for (let i = 0; i < MAX_ENTRIES + 3; i++)
      big[`k${i}`] = { due: i, interval: 1, lapses: 0, successes: 0 };
    const parsed = parseSchedule(serializeSchedule(big));
    expect(Object.keys(parsed)).toHaveLength(MAX_ENTRIES);
    expect(parsed[`k${MAX_ENTRIES + 2}`]).toBeUndefined();
  });

  it('loads and saves under chesslab.trainer, surviving blocked storage', () => {
    const st = memoryStorage();
    const s = recordResult({}, 'C50 Italian Game', true, NOW);
    saveSchedule(st, s);
    expect(Object.keys(st.data)).toEqual([TRAINER_KEY]);
    expect(loadSchedule(st)).toEqual(s);
    const blocked: KeyValueStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(loadSchedule(blocked)).toEqual({});
    expect(() => saveSchedule(blocked, s)).not.toThrow();
    expect(loadSchedule(undefined)).toEqual({});
  });
});
