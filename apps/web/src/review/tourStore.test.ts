// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { buildMoveDetails } from './details';
import { gameToBatch, useReviewStore } from './reviewStore';
import { SCHOLAR_TIMED_PGN, scholarSummary } from './testFixtures';
import { LONG_DWELL_MS, SHORT_DWELL_MS } from './tour';
import { gameKey, installReviewTour, setTourTimer, useTourStore } from './tourStore';

const PGN = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';

function manualTimer() {
  let pending: { fn: () => void; ms: number } | undefined;
  return {
    timer: {
      set: (fn: () => void, ms: number) => (pending = { fn, ms }),
      clear: (h: unknown) => {
        if (pending === h) pending = undefined;
      },
    },
    fire() {
      const p = pending;
      pending = undefined;
      p?.fn();
    },
    get ms() {
      return pending?.ms;
    },
  };
}

function finishReview() {
  const summary = scholarSummary();
  const moveDetails = buildMoveDetails(
    summary,
    gameToBatch(useGameStore.getState()),
    Array.from({ length: 8 }, () => ({})),
  );
  useReviewStore.setState({ status: 'done', summary, moveDetails });
}

let off: () => void;
let t: ReturnType<typeof manualTimer>;

beforeEach(() => {
  useReviewStore.setState({ status: 'idle', summary: undefined, moveDetails: {} });
  useGameStore.getState().loadPgn(PGN);
  useGameStore.getState().goTo(0);
  useUiStore.setState({ activeTab: 'review' });
  useSettingsStore.getState().reset();
  useTourStore.setState({ status: 'idle', started: new Set() });
  t = manualTimer();
  setTourTimer(t.timer);
  off = installReviewTour();
});
afterEach(() => {
  off();
  setTourTimer(undefined);
});

describe('tourStore', () => {
  it('appends "(in time trouble)" to a blunder made with little time left (M22-1)', () => {
    useGameStore.getState().loadPgn(SCHOLAR_TIMED_PGN);
    useGameStore.getState().goTo(0);
    finishReview();
    for (let i = 0; i < 5; i++) t.fire();
    expect(useGameStore.getState().ply).toBe(6);
    expect(useTourStore.getState().text).toMatch(/^3\.\.\. Nf6\?\? Blunder.* \(in time trouble\)$/);
  });

  it('starts when the review is done and drives the game ply', () => {
    finishReview();
    expect(useTourStore.getState().status).toBe('playing');
    expect(useTourStore.getState().total).toBe(2);
    expect(useGameStore.getState().ply).toBe(1);
    expect(t.ms).toBe(SHORT_DWELL_MS);
    for (let i = 0; i < 5; i++) t.fire();
    expect(useGameStore.getState().ply).toBe(6);
    expect(t.ms).toBe(LONG_DWELL_MS);
    expect(useTourStore.getState().text).toMatch(/^3\.\.\. Nf6\?\? Blunder/);
    expect(useTourStore.getState().reached).toBe(1);
    t.fire();
    t.fire();
    expect(useTourStore.getState().status).toBe('finished');
    expect(useGameStore.getState().ply).toBe(7);
  });

  it('stops on navigation the tour did not cause', () => {
    finishReview();
    t.fire();
    useGameStore.getState().goTo(5);
    expect(useTourStore.getState().status).toBe('stopped');
    expect(t.ms).toBeUndefined();
  });

  it('stops when another game is loaded, a move is made or the tab is left', () => {
    finishReview();
    useGameStore.getState().loadPgn('1. d4 d5 2. c4');
    expect(useTourStore.getState().status).toBe('stopped');

    useTourStore.setState({ started: new Set() });
    useReviewStore.setState({ status: 'idle' });
    useGameStore.getState().loadPgn(PGN);
    finishReview();
    expect(useTourStore.getState().status).toBe('playing');
    useUiStore.setState({ activeTab: 'moves' });
    expect(useTourStore.getState().status).toBe('stopped');
  });

  it('starts only once per game and only on the Review tab with the setting on', () => {
    finishReview();
    useTourStore.getState().stop();
    useReviewStore.setState({ status: 'running' });
    finishReview();
    expect(useTourStore.getState().status).toBe('stopped');
    expect(useTourStore.getState().started.has(gameKey(useGameStore.getState()))).toBe(true);

    useTourStore.setState({ started: new Set(), status: 'idle' });
    useReviewStore.setState({ status: 'running' });
    useUiStore.setState({ activeTab: 'moves' });
    finishReview();
    expect(useTourStore.getState().status).toBe('idle');

    useUiStore.setState({ activeTab: 'review' });
    useSettingsStore.getState().set({ reviewTour: false });
    useReviewStore.setState({ status: 'running' });
    finishReview();
    expect(useTourStore.getState().status).toBe('idle');
  });

  it('pause, resume, skip and replay', () => {
    finishReview();
    useTourStore.getState().pause();
    expect(useTourStore.getState().status).toBe('paused');
    useTourStore.getState().resume();
    useTourStore.getState().skip();
    expect(useGameStore.getState().ply).toBe(6);
    useTourStore.getState().stop();
    useTourStore.getState().start();
    expect(useTourStore.getState().status).toBe('playing');
    expect(useGameStore.getState().ply).toBe(1);
  });
});
