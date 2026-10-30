// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { EloEstimate } from '@daisychess/engine-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetEloEstimate,
  useEloStore,
  type EloView,
  type FallbackEstimate,
} from '../../maia/eloEstimate';
import { eloTestGame, newServerAnswer, type EloTestGame } from '../../maia/eloTestUtils';
import { configureHintCache } from '../../maia/hintCache';
import { setMaiaHintClientFactory } from '../../maia/hintClient';
import { resetMaiaHints } from '../../maia/hintStore';
import { fakeMaiaServer, instantSleep } from '../../maia/hintTestUtils';
import { loadOpenings } from '../../openings';
import { buildMoveDetails } from '../../review/details';
import { configureReviewCache } from '../../review/reviewCache';
import { gameToBatch, useReviewStore } from '../../review/reviewStore';
import { tourFinishText, useTourStore } from '../../review/tourStore';
import { useGameStore } from '../../store/gameStore';
import { useSettingsStore } from '../../store/settingsStore';
import { EloLineView } from './EloLine';
import { ReviewPanel } from './ReviewPanel';
import { ReviewTour } from './ReviewTour';

/** The engine colour of a Play-tab game (null: no engine game). */
const engineGame: { player: 'white' | 'black' | null } = { player: null };
vi.mock('../../puzzles/installLedger', async (orig) => ({
  ...(await orig<typeof import('../../puzzles/installLedger')>()),
  activeGameSources: () => (engineGame.player ? { play: engineGame.player } : {}),
}));

const maia = (over: Partial<EloEstimate> = {}): EloEstimate => ({
  method: 'maia',
  rating: 1540,
  low: 1400,
  high: 1700,
  positions: 24,
  exact: true,
  maiaVersion: 1,
  ...over,
});
const fallback = (over: Partial<FallbackEstimate> = {}): FallbackEstimate => ({
  method: 'fallback',
  rating: 1500,
  sd: 250,
  positions: 20,
  meanLoss: 6.2,
  speed: 'blitz',
  provisional: false,
  ...over,
});

afterEach(cleanup);

describe('EloLineView (ADR-024 §5 wording)', () => {
  const text = (view: EloView | undefined) => {
    const { container } = render(<EloLineView side="white" view={view} />);
    return container.textContent ?? '';
  };

  it('Maia: "played like ~1540 here" with the band and the method tooltip', () => {
    render(<EloLineView side="white" view={{ maia: maia() }} />);
    const line = screen.getByTestId('elo-white');
    expect(line.textContent).toBe('played like ~1540 here 1400–1700');
    expect(line.getAttribute('data-method')).toBe('maia');
    expect(line.getAttribute('title')).toContain('lichess-style rating, not FIDE or chess.com');
    expect(line.getAttribute('title')).toContain('24 positions');
  });

  it('Maia at the grid edges: "<1100" / ">1900"; inexact: approximate', () => {
    expect(text({ maia: maia({ rating: 1100, edge: 'low', low: undefined, high: 1300 }) })).toBe(
      'played like <1100 here',
    );
    cleanup();
    expect(text({ maia: maia({ rating: 1900, edge: 'high', high: undefined }) })).toBe(
      'played like >1900 here',
    );
    cleanup();
    expect(text({ maia: maia({ exact: false, low: 1300, high: 1750 }) })).toBe(
      'played like ~1540 here 1300–1750, approximate',
    );
  });

  it('fallback: "≈ 1500 ± 250", approximate (from accuracy); rough estimate when provisional', () => {
    expect(text({ fallback: fallback() })).toBe(
      'played like ≈ 1500 ± 250 here, approximate (from accuracy)',
    );
    cleanup();
    render(<EloLineView side="white" view={{ fallback: fallback({ provisional: true }) }} />);
    const line = screen.getByTestId('elo-white');
    expect(line.textContent).toContain('approximate (from accuracy, rough estimate)');
    expect(line.getAttribute('title')).toContain('not calibrated yet');
  });

  it('pending: the fallback with "Estimating… (12 of 18)"', () => {
    render(
      <EloLineView
        side="white"
        view={{ fallback: fallback(), pending: { done: 12, total: 18 } }}
      />,
    );
    expect(screen.getByTestId('elo-pending-white').textContent).toBe(' Estimating… (12 of 18)');
  });

  it('nothing without a view (engine side, < 10 positions)', () => {
    expect(text(undefined)).toBe('');
  });
});

describe('tour finish text', () => {
  it('names both estimates once', () => {
    expect(tourFinishText({ white: '~1540', black: '~1300' })).toBe(
      'Tour finished — White played like ~1540 here, Black like ~1300.',
    );
    expect(tourFinishText({ black: '≈ 1500' })).toBe(
      'Tour finished — Black played like ≈ 1500 here.',
    );
    expect(tourFinishText({})).toBe('Tour finished — browse the moves or jump to a mistake.');
  });

  it('the finished tour bar shows it for the game on the board', () => {
    useGameStore.getState().loadPgn('1. e4 e5');
    useEloStore.setState({
      status: 'done',
      forMoves: useGameStore.getState().moves,
      estimates: { white: maia(), black: maia({ rating: 1300, edge: 'low' }) },
      fallback: {},
    });
    useTourStore.setState({ status: 'finished' });
    render(<ReviewTour />);
    expect(screen.getByTestId('review-tour-text').textContent).toBe(
      'Tour finished — White played like ~1540 here, Black like <1100.',
    );
    useTourStore.setState({ status: 'idle' });
    resetEloEstimate();
  });
});

describe('ReviewPanel: Elo estimate', () => {
  let game: EloTestGame;

  function showReview(elo?: { white?: EloEstimate; black?: EloEstimate }) {
    const g = useGameStore.getState();
    useReviewStore.setState({
      status: 'done',
      progress: { done: 81, total: 81 },
      summary: game.summary,
      moveDetails: buildMoveDetails(game.summary, gameToBatch(g), []),
      runsOn: { kind: 'server' },
      reviewed: g.moves,
      stored: {
        preset: 'fast',
        createdAt: 1,
        engine: { kind: 'server' },
        fromCache: true,
        source: 'local',
        ...(elo ? { elo } : {}),
      },
    });
  }

  function install() {
    const server = fakeMaiaServer(newServerAnswer(game));
    setMaiaHintClientFactory(server.createClient, { sleep: instantSleep(), minIntervalMs: 0 });
    return server;
  }

  beforeAll(loadOpenings);
  beforeEach(() => {
    engineGame.player = null;
    configureHintCache(null);
    configureReviewCache(null);
    resetMaiaHints();
    resetEloEstimate();
    useSettingsStore.getState().set({ maiaHints: true, reviewEngine: 'auto' });
    game = eloTestGame(80);
    act(() => useGameStore.getState().loadPgn(game.pgn));
  });
  afterEach(() => {
    setMaiaHintClientFactory(null);
    resetMaiaHints();
    resetEloEstimate();
    configureHintCache(undefined);
    configureReviewCache(undefined);
    useReviewStore.setState({ status: 'idle', summary: undefined, stored: undefined });
  });

  it('a record with elo shows the Maia line at once, without a run', async () => {
    const server = install();
    showReview({ white: maia(), black: maia({ rating: 1300, low: 1200, high: 1400 }) });
    render(<ReviewPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('elo-white').textContent).toBe('played like ~1540 here 1400–1700'),
    );
    expect(screen.getByTestId('elo-black').textContent).toContain('~1300');
    expect(server.queries).toHaveLength(0);
  });

  it('the fallback appears at once and is replaced by the Maia line when the run ends', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const server = fakeMaiaServer(newServerAnswer(game));
    const created = server.createClient;
    setMaiaHintClientFactory(
      async (id) => {
        await gate;
        return created(id);
      },
      { sleep: instantSleep(), minIntervalMs: 0 },
    );
    showReview();
    render(<ReviewPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('elo-white').getAttribute('data-method')).toBe('fallback'),
    );
    expect(screen.getByTestId('elo-white').textContent).toContain('approximate');
    expect(screen.getByTestId('elo-pending-white').textContent).toContain('Estimating… (0 of 18)');
    await act(async () => release());
    await waitFor(
      () => expect(screen.getByTestId('elo-white').getAttribute('data-method')).toBe('maia'),
      { timeout: 10_000 },
    );
    expect(screen.getByTestId('elo-white').textContent).toMatch(/^played like ~1\d{3} here/);
    expect(screen.queryByTestId('elo-pending-white')).toBeNull();
  });

  it("the engine's side in a Play-tab review shows nothing", async () => {
    engineGame.player = 'white';
    install();
    showReview();
    render(<ReviewPanel />);
    await waitFor(() => expect(screen.getByTestId('elo-white')).toBeTruthy());
    expect(screen.queryByTestId('elo-black')).toBeNull();
    await waitFor(() => expect(useEloStore.getState().status).toBe('done'), { timeout: 10_000 });
    expect(screen.queryByTestId('elo-black')).toBeNull();
  });

  it('maiaHints off: the approximate fallback only', async () => {
    useSettingsStore.getState().set({ maiaHints: false });
    const server = install();
    showReview();
    render(<ReviewPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('elo-black').getAttribute('data-method')).toBe('fallback'),
    );
    expect(screen.queryByTestId('elo-pending-black')).toBeNull();
    expect(server.queries).toHaveLength(0);
  });
});
