// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureHintCache } from '../../maia/hintCache';
import { setMaiaHintClientFactory } from '../../maia/hintClient';
import { resetMaiaHints, useMaiaHintStore } from '../../maia/hintStore';
import type { MaiaHint } from '../../maia/hints';
import { coded, fakeMaiaServer, instantSleep } from '../../maia/hintTestUtils';
import { loadOpenings } from '../../openings';
import { buildMoveDetails } from '../../review/details';
import { gameToBatch, useReviewStore } from '../../review/reviewStore';
import { SCHOLAR_TIMED_PGN, scholarSummary } from '../../review/testFixtures';
import { useGameStore } from '../../store/gameStore';
import { useSettingsStore } from '../../store/settingsStore';
import { MoveCommentary } from './MoveCommentary';
import { NO_TOKEN_HINTS_NOTE } from '../../server/tokenMessages';
import { ReviewPanel } from './ReviewPanel';

const PGN =
  '[White "Ann"]\n[Black "Bob"]\n[WhiteElo "1480"]\n[BlackElo "1510"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';

function details() {
  const results = Array.from({ length: 8 }, () => ({}));
  results[5] = { pv: ['g7g6', 'h5f3', 'g8f6'] };
  return buildMoveDetails(scholarSummary(), gameToBatch(useGameStore.getState()), results);
}

function showHint(hint: Partial<MaiaHint>, levels = { rating: 1500 }) {
  const level = { ...levels, source: 'pgn' as const, elo: 1510 };
  useMaiaHintStore.setState({
    status: 'done',
    forMoves: useGameStore.getState().moves,
    levels: { white: level, black: level },
    hints: {
      6: {
        ply: 6,
        rating: level.rating,
        top: [
          { uci: 'g7g6', san: 'g6', p: 0.41 },
          { uci: 'd8e7', san: 'Qe7', p: 0.2 },
          { uci: 'g8f6', san: 'Nf6', p: 0.08 },
        ],
        playedP: 0.08,
        bestP: 0.41,
        playedIsTop: false,
        entries: 5,
        minP: 0.02,
        ...hint,
      },
    },
  });
}

const start = vi.fn(() => Promise.resolve(undefined));
beforeAll(loadOpenings);
beforeEach(() => {
  configureHintCache(null);
  setMaiaHintClientFactory(null);
  resetMaiaHints();
  useSettingsStore.getState().reset();
  useGameStore.getState().reset();
  useReviewStore.setState({
    status: 'idle',
    summary: undefined,
    moveDetails: {},
    reviewed: undefined,
    stored: undefined,
    runsOn: undefined,
    autoNotice: false,
    start,
  });
});
afterEach(() => {
  cleanup();
  setMaiaHintClientFactory(null);
  resetMaiaHints();
  configureHintCache(undefined);
});

describe('Maia hint in the move card', () => {
  const renderCard = (pgn = PGN) => {
    act(() => {
      useGameStore.getState().loadPgn(pgn);
    });
    render(<MoveCommentary summary={scholarSummary()} details={details()} />);
    act(() => useGameStore.getState().goTo(6));
  };

  it('"At 1500, 41% would play g6 here"', () => {
    renderCard();
    act(() => showHint({}));
    expect(screen.getByTestId('move-card-maia').textContent).toBe(
      'At 1500, 41% would play g6 here (Nf6?? in the game: 8%).',
    );
    expect(screen.getByTestId('move-card-maia').getAttribute('title')).toBe(
      'Maia 1500 — from the PGN rating 1510',
    );
  });

  it('"A very common blunder at 1500" when the blunder is Maia\'s top move', () => {
    renderCard();
    act(() =>
      showHint({
        top: [
          { uci: 'g8f6', san: 'Nf6', p: 0.38 },
          { uci: 'g7g6', san: 'g6', p: 0.3 },
        ],
        playedP: 0.38,
        bestP: 0.3,
        playedIsTop: true,
      }),
    );
    expect(screen.getByTestId('move-card-maia').textContent).toBe(
      'A very common blunder at 1500: 38% of players play this.',
    );
  });

  it('"The engine move g6 is hard to find" next to the time-trouble badge', () => {
    renderCard(SCHOLAR_TIMED_PGN);
    act(() =>
      showHint({
        top: [
          { uci: 'd8e7', san: 'Qe7', p: 0.45 },
          { uci: 'g8f6', san: 'Nf6', p: 0.2 },
        ],
        playedP: 0.2,
        bestP: 0.03,
      }),
    );
    expect(screen.getByTestId('time-trouble-badge')).toBeTruthy();
    const lines = [...screen.getByTestId('move-card-maia').querySelectorAll('p')].map(
      (p) => p.textContent,
    );
    expect(lines).toEqual([
      'At 1500, 45% would play Qe7 here (Nf6?? in the game: 20%).',
      'The engine move g6 is hard to find: only 3% at 1500.',
    ]);
  });

  it('nothing for another game, other plies or with the setting off', () => {
    renderCard();
    act(() => showHint({}));
    act(() => useGameStore.getState().goTo(5));
    expect(screen.queryByTestId('move-card-maia')).toBeNull();
    act(() => useGameStore.getState().goTo(6));
    expect(screen.getByTestId('move-card-maia')).toBeTruthy();
    act(() => useMaiaHintStore.setState({ forMoves: [] }));
    expect(screen.queryByTestId('move-card-maia')).toBeNull();
  });
});

describe('Maia hints in the review panel', () => {
  const done = () => {
    act(() => {
      useGameStore.getState().loadPgn(PGN);
    });
    const moves = useGameStore.getState().moves;
    useReviewStore.setState({
      status: 'done',
      summary: scholarSummary(),
      moveDetails: details(),
      reviewed: moves,
      runsOn: { kind: 'server' },
    });
  };

  it('requests hints when the review is done: move card text and typical-mistakes summary', async () => {
    const server = fakeMaiaServer((_r, fen) =>
      fen.includes(' b ')
        ? [
            { uci: 'g8f6', p: 0.38 },
            { uci: 'g7g6', p: 0.3 },
          ]
        : [
            { uci: 'g1f3', p: 0.5 },
            { uci: 'd1h5', p: 0.1 },
          ],
    );
    setMaiaHintClientFactory(server.createClient, { sleep: instantSleep(), minIntervalMs: 0 });
    done();
    render(<ReviewPanel />);
    act(() => useGameStore.getState().goTo(6));
    await waitFor(() =>
      expect(screen.getByTestId('move-card-maia').textContent).toBe(
        'A very common blunder at 1500: 38% of players play this.',
      ),
    );
    expect(server.created).toEqual(['maia-1500']);
    expect(server.queries).toHaveLength(2);
    expect(screen.getByTestId('maia-summary-black').textContent).toBe(
      'Bob at 1500: 1 typical, 0 unusual',
    );
    // White's only error is an inaccuracy (not counted in the summary).
    expect(screen.queryByTestId('maia-summary-white')).toBeNull();
    expect(screen.queryByTestId('maia-token-note')).toBeNull();
  });

  it('refused token: one muted line, no hints', async () => {
    const server = fakeMaiaServer(() => undefined, { load: () => coded('unauthorized') });
    setMaiaHintClientFactory(server.createClient, { sleep: instantSleep() });
    done();
    render(<ReviewPanel />);
    await waitFor(() => expect(screen.getByTestId('maia-token-note').textContent).toBe(NO_TOKEN_HINTS_NOTE));
    expect(screen.queryByTestId('maia-summary')).toBeNull();
    act(() => useGameStore.getState().goTo(6));
    expect(screen.queryByTestId('move-card-maia')).toBeNull();
  });

  it('no server: nothing is shown, nothing queried', async () => {
    done();
    render(<ReviewPanel />);
    await waitFor(() => expect(useMaiaHintStore.getState().status).toBe('unavailable'));
    expect(screen.queryByTestId('maia-token-note')).toBeNull();
    expect(screen.queryByTestId('maia-summary')).toBeNull();
  });

  it('setting off: no request', async () => {
    const server = fakeMaiaServer(() => undefined);
    setMaiaHintClientFactory(server.createClient, { sleep: instantSleep() });
    useSettingsStore.getState().set({ maiaHints: false });
    done();
    render(<ReviewPanel />);
    await waitFor(() => expect(useMaiaHintStore.getState().status).toBe('off'));
    expect(server.created).toEqual([]);
  });
});
