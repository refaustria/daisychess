import { GLICKO_DEFAULT } from '@daisychess/puzzles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyPuzzleResult,
  configurePuzzlesStorage,
  dailyStreak,
  defaultPuzzlesState,
  getPuzzlesState,
  loadPuzzlesState,
  markSeen,
  MAX_DAILY_RESULTS,
  MAX_SEEN,
  parsePuzzlesState,
  PUZZLES_KEY,
  recentDailyResults,
  recordDaily,
  recordRush,
  resetPuzzlesState,
  savePuzzlesState,
  seenSet,
  serializePuzzlesState,
  subscribePuzzlesState,
  updatePuzzlesState,
  type KeyValueStorage,
  type PuzzlesState,
} from './puzzlesState';

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

afterEach(() => configurePuzzlesStorage(undefined));

describe('parsePuzzlesState', () => {
  it('returns the defaults for nothing, garbage and other versions', () => {
    const d = defaultPuzzlesState();
    expect(d.rating).toEqual({ r: 1500, rd: 350, vol: GLICKO_DEFAULT.vol, n: 0 });
    for (const raw of [null, '', '{', '[]', '42', 'null', '{"v":2,"rating":{"r":1}}']) {
      expect(parsePuzzlesState(raw)).toEqual(d);
    }
  });

  it('round-trips a full state', () => {
    const s: PuzzlesState = {
      v: 1,
      rating: { r: 1620.5, rd: 85.2, vol: 0.0899, n: 42 },
      difficulty: 'harder',
      filter: { theme: 'fork', opening: 'Sicilian_Defense' },
      daily: { streak: 3, last: '2026-10-26', results: { '2026-10-26': 'solved' } },
      rush: { best3: 12, best5: 20 },
      seen: ['a', 'b'],
    };
    expect(parsePuzzlesState(serializePuzzlesState(s))).toEqual(s);
  });

  it('repairs invalid parts one by one', () => {
    const raw = JSON.stringify({
      v: 1,
      rating: { r: 'x', rd: 50, vol: 0.06, n: 3 },
      difficulty: 'impossible',
      filter: { theme: 7, opening: 'x'.repeat(500) },
      daily: {
        streak: -4,
        last: 'yesterday',
        results: { '2026-10-01': 'solved', nope: 'solved', '2026-10-02': 'maybe' },
      },
      rush: { best3: 4.7, best5: -1 },
      seen: ['a', 5, '', 'b', 'a', null],
    });
    const s = parsePuzzlesState(raw);
    expect(s.rating).toEqual(defaultPuzzlesState().rating);
    expect(s.difficulty).toBe('normal');
    expect(s.filter).toEqual({});
    expect(s.daily).toEqual({ streak: 0, last: '', results: { '2026-10-01': 'solved' } });
    expect(s.rush).toEqual({ best3: 4, best5: 0 });
    expect(s.seen).toEqual(['a', 'b']);
  });

  it('keeps a valid rating with a bad volatility and caps the seen ring', () => {
    const seen = Array.from({ length: MAX_SEEN + 10 }, (_, i) => `id${i}`);
    const s = parsePuzzlesState(
      JSON.stringify({ v: 1, rating: { r: 1800, rd: 60, vol: -1, n: 7 }, seen }),
    );
    expect(s.rating).toEqual({ r: 1800, rd: 60, vol: GLICKO_DEFAULT.vol, n: 7 });
    expect(s.seen).toHaveLength(MAX_SEEN);
    expect(s.seen[0]).toBe('id10');
  });

  it('stays under 50 kB with a full seen ring of lichess ids', () => {
    let s = defaultPuzzlesState();
    for (let i = 0; i < MAX_SEEN; i++)
      s = { ...s, seen: [...s.seen, i.toString(36).padStart(5, '0')] };
    expect(serializePuzzlesState(s).length).toBeLessThan(50_000);
  });
});

describe('applyPuzzleResult', () => {
  it('moves the rating up on a solve and down on a fail; counts rated puzzles', () => {
    const s = defaultPuzzlesState();
    const up = applyPuzzleResult(s, { rating: 1500, rd: 80 }, true);
    const down = applyPuzzleResult(s, { rating: 1500, rd: 80 }, false);
    expect(up.rating.r).toBeGreaterThan(1500);
    expect(down.rating.r).toBeLessThan(1500);
    expect(up.rating.rd).toBeLessThan(350);
    expect(up.rating.n).toBe(1);
    expect(s.rating.n).toBe(0);
  });

  it('ignores unrated puzzles', () => {
    const s = defaultPuzzlesState();
    expect(applyPuzzleResult(s, {}, true)).toBe(s);
  });
});

describe('markSeen', () => {
  it('appends, moves a repeat to the end and caps the ring', () => {
    let s = defaultPuzzlesState();
    s = markSeen(markSeen(markSeen(s, 'a'), 'b'), 'a');
    expect(s.seen).toEqual(['b', 'a']);
    expect(markSeen(s, 'a')).toBe(s);
    s = { ...s, seen: Array.from({ length: MAX_SEEN }, (_, i) => `x${i}`) };
    s = markSeen(s, 'new');
    expect(s.seen).toHaveLength(MAX_SEEN);
    expect(s.seen[0]).toBe('x1');
    expect(seenSet(s).has('new')).toBe(true);
  });
});

describe('daily results', () => {
  it('counts consecutive solved days, resets on a fail and after a gap', () => {
    let s = defaultPuzzlesState();
    s = recordDaily(s, '2026-10-01', 'solved');
    s = recordDaily(s, '2026-10-02', 'solved');
    expect(s.daily.streak).toBe(2);
    expect(dailyStreak(s, '2026-10-02')).toBe(2);
    expect(dailyStreak(s, '2026-10-03')).toBe(2);
    expect(dailyStreak(s, '2026-10-04')).toBe(0);
    s = recordDaily(s, '2026-10-04', 'solved');
    expect(s.daily.streak).toBe(1);
    s = recordDaily(s, '2026-10-05', 'failed');
    expect(s.daily.streak).toBe(0);
    s = recordDaily(s, '2026-10-06', 'solved');
    expect(s.daily.streak).toBe(1);
    expect(s.daily.last).toBe('2026-10-06');
  });

  it('keeps the first result of a day; across month and year ends', () => {
    let s = recordDaily(defaultPuzzlesState(), '2026-12-31', 'solved');
    expect(recordDaily(s, '2026-12-31', 'failed')).toBe(s);
    s = recordDaily(s, '2027-01-01', 'solved');
    expect(s.daily.streak).toBe(2);
  });

  it('records an older date without moving the streak; ignores bad dates', () => {
    let s = recordDaily(defaultPuzzlesState(), '2026-10-10', 'solved');
    s = recordDaily(s, '2026-10-05', 'failed');
    expect(s.daily).toMatchObject({ streak: 1, last: '2026-10-10' });
    expect(s.daily.results['2026-10-05']).toBe('failed');
    expect(recordDaily(s, '10/11/2026', 'solved')).toBe(s);
  });

  it('keeps the most recent results only and lists the last n oldest first', () => {
    let s = defaultPuzzlesState();
    const start = Date.UTC(2026, 0, 1);
    for (let i = 0; i < MAX_DAILY_RESULTS + 5; i++) {
      s = recordDaily(s, new Date(start + i * 86_400_000).toISOString().slice(0, 10), 'solved');
    }
    expect(Object.keys(s.daily.results)).toHaveLength(MAX_DAILY_RESULTS);
    expect(s.daily.results['2026-01-01']).toBeUndefined();
    const recent = recentDailyResults(s, 3);
    expect(recent.map((r) => r.date)).toEqual(['2026-03-04', '2026-03-05', '2026-03-06']);
    expect(s.daily.streak).toBe(MAX_DAILY_RESULTS + 5);
  });
});

describe('recordRush', () => {
  it('keeps the best score per duration', () => {
    let s = recordRush(defaultPuzzlesState(), 3, 10);
    s = recordRush(s, 3, 7);
    s = recordRush(s, 5, 14);
    expect(s.rush).toEqual({ best3: 10, best5: 14 });
    expect(recordRush(s, 5, 14)).toBe(s);
  });
});

describe('storage and the shared holder', () => {
  it('loads and saves under daisychess.puzzles', () => {
    const st = memoryStorage();
    const s = { ...defaultPuzzlesState(), difficulty: 'easier' as const };
    savePuzzlesState(st, s);
    expect(JSON.parse(st.data[PUZZLES_KEY]!).v).toBe(1);
    expect(loadPuzzlesState(st).difficulty).toBe('easier');
  });

  it('survives a throwing storage', () => {
    const bad: KeyValueStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(loadPuzzlesState(bad)).toEqual(defaultPuzzlesState());
    expect(() => savePuzzlesState(bad, defaultPuzzlesState())).not.toThrow();
    configurePuzzlesStorage(bad);
    expect(updatePuzzlesState((s) => markSeen(s, 'a')).seen).toEqual(['a']);
    expect(getPuzzlesState().seen).toEqual(['a']);
  });

  it('updates, persists, notifies and resets', () => {
    const st = memoryStorage({
      [PUZZLES_KEY]: JSON.stringify({ v: 1, rush: { best3: 5, best5: 0 } }),
    });
    configurePuzzlesStorage(st);
    expect(getPuzzlesState().rush.best3).toBe(5);
    const listener = vi.fn();
    const off = subscribePuzzlesState(listener);
    const same = getPuzzlesState();
    expect(updatePuzzlesState((s) => s)).toBe(same);
    expect(listener).not.toHaveBeenCalled();
    updatePuzzlesState((s) => markSeen(s, 'p1'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(st.data[PUZZLES_KEY]!).seen).toEqual(['p1']);
    resetPuzzlesState();
    expect(getPuzzlesState()).toEqual(defaultPuzzlesState());
    expect(parsePuzzlesState(st.data[PUZZLES_KEY]!)).toEqual(defaultPuzzlesState());
    off();
    updatePuzzlesState((s) => markSeen(s, 'p2'));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('uses localStorage by default', () => {
    localStorage.removeItem(PUZZLES_KEY);
    configurePuzzlesStorage(undefined);
    updatePuzzlesState((s) => ({ ...s, difficulty: 'harder' }));
    expect(JSON.parse(localStorage.getItem(PUZZLES_KEY)!).difficulty).toBe('harder');
    localStorage.removeItem(PUZZLES_KEY);
  });
});
