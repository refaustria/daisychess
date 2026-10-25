import { describe, expect, it } from 'vitest';
import type {
  AnalyzeMessage,
  BestMoveMessage,
  ErrorMessage,
  InfoMessage,
} from '@daisychess/engine-core';
import { SessionTracker } from './SessionTracker.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const analyze = (sessionId: string, searchId: number): AnalyzeMessage => ({
  type: 'analyze',
  sessionId,
  searchId,
  engine: 'sf',
  fen: FEN,
});
const bestmove = (sessionId: string, searchId: number): BestMoveMessage => ({
  type: 'bestmove',
  sessionId,
  searchId,
  bestMove: null,
  reason: 'stopped',
});
const info = (sessionId: string, searchId: number): InfoMessage => ({
  type: 'info',
  sessionId,
  searchId,
  info: { depth: 1, multipv: 1, score: { cp: 10 }, pv: ['e2e4'] },
});
const error = (sessionId?: string, searchId?: number): ErrorMessage => ({
  type: 'error',
  code: 'engine_crashed',
  message: 'x',
  ...(sessionId !== undefined ? { sessionId } : {}),
  ...(searchId !== undefined ? { searchId } : {}),
});

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('SessionTracker', () => {
  it('analyze opens the session once and starts each search; bestmove ends it with timings', () => {
    const c = clock();
    const t = new SessionTracker(c.now);
    expect(t.in(analyze('a', 1))).toEqual([
      { kind: 'session_opened', sessionId: 'a' },
      { kind: 'search_started', sessionId: 'a', searchId: 1, startedAt: 1_000 },
    ]);
    c.advance(50);
    expect(t.in(analyze('a', 2))).toEqual([
      { kind: 'search_started', sessionId: 'a', searchId: 2, startedAt: 1_050 },
    ]);
    expect(t.openSearches('a')).toEqual([1, 2]);
    expect(t.openSearchCount).toBe(2);
    c.advance(100);
    expect(t.out(bestmove('a', 1))).toEqual([
      { kind: 'search_ended', sessionId: 'a', searchId: 1, startedAt: 1_000, endedAt: 1_150 },
    ]);
    expect(t.out(error('a', 2))).toEqual([
      { kind: 'search_ended', sessionId: 'a', searchId: 2, startedAt: 1_050, endedAt: 1_150 },
    ]);
    expect(t.openSearchCount).toBe(0);
    expect(t.openSessions).toEqual(['a']);
  });

  it('info and stop change nothing; unknown, duplicate and repeated terminals are ignored', () => {
    const t = new SessionTracker(() => 0);
    t.in(analyze('a', 1));
    expect(t.in(analyze('a', 1))).toEqual([]); // duplicate searchId
    expect(t.out(info('a', 1))).toEqual([]);
    expect(t.in({ type: 'stop', sessionId: 'a' })).toEqual([]);
    expect(t.out(bestmove('a', 9))).toEqual([]);
    expect(t.out(bestmove('b', 1))).toEqual([]);
    expect(t.out(bestmove('a', 1))).toHaveLength(1);
    expect(t.out(bestmove('a', 1))).toEqual([]);
    expect(t.out(error())).toEqual([]); // connection-level error
  });

  it('release closes the session but keeps its open searches until their terminal', () => {
    const t = new SessionTracker(() => 5);
    t.in(analyze('a', 3));
    expect(t.in({ type: 'release', sessionId: 'a' })).toEqual([
      { kind: 'session_closed', sessionId: 'a' },
    ]);
    expect(t.in({ type: 'release', sessionId: 'a' })).toEqual([]); // idempotent
    expect(t.openSessions).toEqual([]);
    expect(t.openSearchList()).toEqual([{ sessionId: 'a', searchId: 3, startedAt: 5 }]);
    // Reopened with the same id while the old search still finishes.
    expect(t.in(analyze('a', 4)).map((e) => e.kind)).toEqual(['session_opened', 'search_started']);
    expect(t.openSearches('a')).toEqual([3, 4]);
    expect(t.out(bestmove('a', 3))).toHaveLength(1);
    expect(t.openSearches('a')).toEqual([4]);
  });

  it('a session-level error (no searchId) closes the session only', () => {
    const t = new SessionTracker(() => 0);
    t.in(analyze('a', 1));
    t.in(analyze('b', 1));
    expect(t.out(error('a'))).toEqual([{ kind: 'session_closed', sessionId: 'a' }]);
    expect(t.out(error('a'))).toEqual([]);
    expect(t.openSessions).toEqual(['b']);
    expect(t.openSearchList().map((s) => `${s.sessionId}/${s.searchId}`)).toEqual(['a/1', 'b/1']);
  });

  it('a stop/release for a never-opened session reports nothing', () => {
    const t = new SessionTracker();
    expect(t.in({ type: 'release', sessionId: 'x' })).toEqual([]);
    expect(t.out(error('x'))).toEqual([]);
    expect(t.openSearches('x')).toEqual([]);
  });
});
