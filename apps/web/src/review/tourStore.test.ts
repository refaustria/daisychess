// @vitest-environment jsdom
import { fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBoardKeys } from '../components/Controls/Controls';
import { configureGameLedger, getLedgerGame } from '../puzzles/gameLedger';
import type { Side } from '../puzzles/userSide';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { buildMoveDetails } from './details';
import { gameKey as reviewGameKey } from './reviewCache';
import { gameToBatch, useReviewStore } from './reviewStore';
import { SCHOLAR_TIMED_PGN, scholarSummary } from './testFixtures';
import { LONG_DWELL_MS, SHORT_DWELL_MS } from './tour';
import {
  gameKey,
  installReviewTour,
  setTourTimer,
  setTourUserSide,
  useTourStore,
} from './tourStore';

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

const tour = () => useTourStore.getState();
const ply = () => useGameStore.getState().ply;
/** Waits for the async start (user side, opening book) of an automatic tour. */
const running = () => vi.waitFor(() => expect(tour().status).not.toBe('idle'));

let off: () => void;
let t: ReturnType<typeof manualTimer>;
let side: Side;

beforeEach(() => {
  configureGameLedger(null);
  useReviewStore.setState({ status: 'idle', summary: undefined, moveDetails: {} });
  useGameStore.getState().loadPgn(PGN);
  useGameStore.getState().goTo(0);
  useUiStore.setState({ activeTab: 'review' });
  useSettingsStore.getState().reset();
  useTourStore.setState({ status: 'idle', started: new Set(), userSide: undefined, card: undefined });
  side = 'white';
  setTourUserSide(async () => side);
  t = manualTimer();
  setTourTimer(t.timer);
  off = installReviewTour();
});
afterEach(() => {
  off();
  setTourTimer(undefined);
  setTourUserSide(undefined);
});

describe('tourStore', () => {
  it('appends "(in time trouble)" to a blunder made with little time left (M22-1)', async () => {
    useGameStore.getState().loadPgn(SCHOLAR_TIMED_PGN);
    useGameStore.getState().goTo(0);
    finishReview();
    await running();
    t.fire();
    t.fire();
    t.fire();
    expect(tour().status).toBe('waiting'); // the opening stop on 2... Nc6
    tour().next();
    t.fire();
    expect(ply()).toBe(6);
    expect(tour().text).toMatch(/^3\.\.\. Nf6\?\? Blunder.* \(in time trouble\)$/);
  });

  it('starts when the review is done, waits at the opening stop and drives the game ply', async () => {
    finishReview();
    await running();
    expect(tour().status).toBe('playing');
    expect(tour().userSide).toBe('white');
    expect(tour().total).toBe(1);
    expect(ply()).toBe(1);
    expect(t.ms).toBe(SHORT_DWELL_MS);
    t.fire();
    t.fire();
    t.fire();
    expect(ply()).toBe(4);
    expect(tour().status).toBe('waiting');
    expect(t.ms).toBeUndefined();
    expect(tour().reached).toBe(1);
    const card = tour().card;
    expect(card?.kind).toBe('opening');
    if (card?.kind !== 'opening') throw new Error('opening card expected');
    expect(card.title).toBe("Opening: Bishop's Opening (C23)");
    expect(card.familyText).toBeTruthy();
    expect(card.sentences[0]).toBe('Book until move 2 (…Nc6).');

    tour().next();
    expect(tour().status).toBe('playing');
    expect(tour().card).toBeUndefined();
    expect(ply()).toBe(5);
    t.fire();
    // Black's blunder is the opponent's: a long dwell, no stop.
    expect(ply()).toBe(6);
    expect(tour().status).toBe('playing');
    expect(t.ms).toBe(LONG_DWELL_MS);
    expect(tour().text).toMatch(/^3\.\.\. Nf6\?\? Blunder/);
    t.fire();
    t.fire();
    expect(tour().status).toBe('finished');
    expect(ply()).toBe(7);
  });

  it("stops at the user's own blunder with a mistake card", async () => {
    side = 'black';
    finishReview();
    await running();
    expect(tour().total).toBe(2);
    tour().skip();
    expect(ply()).toBe(4);
    tour().skip();
    expect(ply()).toBe(6);
    expect(tour().status).toBe('waiting');
    expect(tour().reached).toBe(2);
    const card = tour().card;
    expect(card?.kind).toBe('mistake');
    if (card?.kind !== 'mistake') throw new Error('mistake card expected');
    expect(card.ply).toBe(6);
    expect(card.text).toMatch(/^3\.\.\. Nf6\?\? Blunder .*: better was g6$/);
  });

  it('stops on navigation the tour did not cause', async () => {
    finishReview();
    await running();
    t.fire();
    useGameStore.getState().goTo(5);
    expect(tour().status).toBe('stopped');
    expect(t.ms).toBeUndefined();
  });

  it('stops when another game is loaded, a move is made or the tab is left', async () => {
    finishReview();
    await running();
    useGameStore.getState().loadPgn('1. d4 d5 2. c4');
    expect(tour().status).toBe('stopped');

    useTourStore.setState({ started: new Set() });
    useReviewStore.setState({ status: 'idle' });
    useGameStore.getState().loadPgn(PGN);
    finishReview();
    await vi.waitFor(() => expect(tour().status).toBe('playing'));
    useUiStore.setState({ activeTab: 'moves' });
    expect(tour().status).toBe('stopped');
  });

  it('starts only once per game and only on the Review tab with the setting on', async () => {
    finishReview();
    await running();
    tour().stop();
    useReviewStore.setState({ status: 'running' });
    finishReview();
    await Promise.resolve();
    expect(tour().status).toBe('stopped');
    expect(tour().started.has(gameKey(useGameStore.getState()))).toBe(true);

    useTourStore.setState({ started: new Set(), status: 'idle' });
    useReviewStore.setState({ status: 'running' });
    useUiStore.setState({ activeTab: 'moves' });
    finishReview();
    await new Promise((r) => setTimeout(r, 10));
    expect(tour().status).toBe('idle');

    useUiStore.setState({ activeTab: 'review' });
    useSettingsStore.getState().set({ reviewTour: false });
    useReviewStore.setState({ status: 'running' });
    finishReview();
    await new Promise((r) => setTimeout(r, 10));
    expect(tour().status).toBe('idle');
  });

  it('pause, resume, skip and replay', async () => {
    finishReview();
    await running();
    tour().pause();
    expect(tour().status).toBe('paused');
    tour().resume();
    tour().skip();
    expect(ply()).toBe(4);
    expect(tour().status).toBe('waiting');
    tour().stop();
    await tour().start();
    expect(tour().status).toBe('playing');
    expect(ply()).toBe(1);
  });

  it('a start that resolves after a stop or a game change is dropped', async () => {
    let release: (s: Side) => void = () => undefined;
    setTourUserSide(() => new Promise<Side>((r) => (release = r)));
    finishReview();
    tour().stop();
    release('white');
    await new Promise((r) => setTimeout(r, 10));
    expect(tour().status).toBe('idle');
    expect(ply()).toBe(0);

    const pending = tour().start();
    useGameStore.getState().loadPgn('1. d4 d5');
    release('white');
    await pending;
    expect(tour().status).toBe('idle');
  });

  it('falls back to the board orientation when the side cannot be resolved', async () => {
    setTourUserSide(() => Promise.reject(new Error('no ledger')));
    useGameStore.getState().flip();
    finishReview();
    await running();
    expect(tour().userSide).toBe('black');
  });
});

describe('tour keys', () => {
  async function atOpeningStop() {
    finishReview();
    await running();
    tour().skip();
    expect(tour().status).toBe('waiting');
    expect(ply()).toBe(4);
  }

  it('→ while waiting continues once (the board keys do not also step)', async () => {
    const keys = renderHook(() => useBoardKeys());
    await atOpeningStop();
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(tour().status).toBe('playing');
    expect(ply()).toBe(5);
    keys.unmount();
  });

  it('→ while playing is navigation: it stops the tour (unchanged)', async () => {
    const keys = renderHook(() => useBoardKeys());
    finishReview();
    await running();
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(tour().status).toBe('stopped');
    expect(ply()).toBe(2);
    keys.unmount();
  });

  it('Enter and Space continue, Escape stops', async () => {
    await atOpeningStop();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(ply()).toBe(5);
    tour().stop();
    await tour().start();
    tour().skip();
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(ply()).toBe(5);
    tour().stop();
    await tour().start();
    tour().skip();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(tour().status).toBe('stopped');
  });

  it('keys inside an input, with modifiers or on another button are left alone', async () => {
    await atOpeningStop();
    const input = document.createElement('input');
    const button = document.createElement('button');
    document.body.append(input, button);
    try {
      for (const key of ['ArrowRight', 'Enter', ' ', 'Escape'])
        fireEvent.keyDown(input, { key });
      fireEvent.keyDown(document.body, { key: 'ArrowRight', ctrlKey: true });
      fireEvent.keyDown(button, { key: 'Enter' });
      fireEvent.keyDown(document.body, { key: 'a' });
      expect(tour().status).toBe('waiting');
      expect(ply()).toBe(4);
      // An arrow on a button still continues.
      fireEvent.keyDown(button, { key: 'ArrowRight' });
      expect(ply()).toBe(5);
    } finally {
      input.remove();
      button.remove();
    }
  });

  it('keys do nothing while no tour waits', async () => {
    fireEvent.keyDown(document.body, { key: 'Enter' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(tour().status).toBe('idle');
    finishReview();
    await running();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(tour().status).toBe('playing');
  });
});

describe('switch side', () => {
  it("restarts with the other side's stops and stores the side in the ledger", async () => {
    finishReview();
    await running();
    expect(tour().total).toBe(1);
    await tour().switchSide();
    expect(tour().userSide).toBe('black');
    expect(tour().total).toBe(2);
    expect(tour().status).toBe('playing');
    expect(ply()).toBe(1);
    const g = useGameStore.getState();
    const key = reviewGameKey(
      g.startFen,
      gameToBatch(g).moves.map((m) => m.uci),
    );
    expect((await getLedgerGame(key))?.userSide).toBe('black');
    await tour().switchSide();
    expect(tour().userSide).toBe('white');
    expect(tour().total).toBe(1);
  });
});
