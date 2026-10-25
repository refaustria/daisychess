// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reviewStart = vi.fn(() => Promise.resolve(undefined));
const reviewReset = vi.fn();
/** Extra review state the mocked store reports (status, reviewed moves). */
let reviewExtra: Record<string, unknown> = {};
vi.mock('../../review/reviewStore', () => ({
  REVIEW_PRESETS: { fast: { movetime: 300 }, deep: { depth: 14 } },
  useReviewStore: {
    getState: () => ({ start: reviewStart, reset: reviewReset, ...reviewExtra }),
  },
}));

import { FakePlayEngine } from '../../play/fakePlayEngine';
import { useLiveStore } from '../../live/liveStore';
import { configurePlay, resetPlay, usePlayStore } from '../../play/playStore';
import { useGameStore } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { PlayIndicator } from './PlayIndicator';
import { PlayPanel } from './PlayPanel';
import { PlayerBar, useBoardPlayers } from '../PlayerBar/PlayerBar';
import { MaiaOpponent } from '../../maia/opponent';
import { FakeMaiaServer, MAIA_WELCOME } from '../../maia/opponentTesting';
import { setHumanProbe } from '../../maia/opponentProbe';
import { useAnalysisStore } from '../../store/analysisStore';
import type { ServerProbeState } from '../../engine/registry';

/** The board's player bars (as in App), for the clocks that moved out of the panel. */
function Bars() {
  const p = useBoardPlayers();
  const top = p.orientation === 'white' ? 'black' : 'white';
  return (
    <>
      <PlayerBar side={top} player={p[top]} position="top" />
      <PlayerBar side={p.orientation} player={p[p.orientation]} position="bottom" />
    </>
  );
}

let engine: FakePlayEngine;
const takeBack = () => screen.getByRole('button', { name: 'Take back' }) as HTMLButtonElement;

beforeEach(async () => {
  engine = new FakePlayEngine();
  await configurePlay({ createEngine: () => engine, extraDelayMs: () => 0, random: () => 0.1 });
  usePlayStore.setState({
    setup: { color: 'white', strength: '1500', moveTime: 500, timeControl: null },
  });
  useGameStore.getState().reset();
  reviewStart.mockClear();
  reviewReset.mockClear();
  reviewExtra = {};
});

afterEach(async () => {
  cleanup();
  await act(() => resetPlay());
});

describe('PlayPanel', () => {
  it('setup form: colour, strength, time, Start', async () => {
    render(<PlayPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'Black' }));
    fireEvent.change(screen.getByLabelText('Strength'), { target: { value: '2400' } });
    fireEvent.change(screen.getByLabelText('Thinking time'), { target: { value: '100' } });
    expect((screen.getByRole('radio', { name: 'Black' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(usePlayStore.getState()).toMatchObject({
      mode: 'playing',
      playerColor: 'black',
      setup: { color: 'black', strength: '2400', moveTime: 100 },
    });
    await waitFor(() => expect(useGameStore.getState().moves).toHaveLength(1));
    expect(engine.options).toEqual([{ UCI_LimitStrength: true, UCI_Elo: 2400 }]);
    expect(engine.searches[0]?.opts).toEqual({ movetime: 100 });
  });

  it('playing: thinking status and indicator, take back, resign → result, rematch', async () => {
    engine.manual = true;
    render(
      <>
        <PlayPanel />
        <PlayIndicator />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(screen.getByTestId('play-status').textContent).toContain('Your move');
    expect(takeBack().disabled).toBe(true);
    act(() => {
      useGameStore.getState().makeMove('e2', 'e4');
    });
    expect(screen.getByTestId('play-status').textContent).toContain('Engine thinking…');
    expect(screen.getByTestId('engine-thinking')).toBeTruthy();
    expect(takeBack().disabled).toBe(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      engine.release();
    });
    await waitFor(() =>
      expect(screen.getByTestId('play-status').textContent).toContain('Your move'),
    );
    expect(screen.queryByTestId('engine-thinking')).toBeNull();
    expect(useGameStore.getState().moves).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Take back' }));
    expect(useGameStore.getState().moves).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Resign' }));
    expect(screen.getByTestId('play-result').textContent).toContain('0-1');
    expect(screen.getByText('You lost')).toBeTruthy();
    expect(screen.getByText(/Resignation/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Rematch' }));
    expect(usePlayStore.getState().mode).toBe('playing');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
  });

  it('engine error shows the message', async () => {
    engine.failSearch = new Error('worker crashed');
    render(<PlayPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'Black' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect((await screen.findByRole('alert')).textContent).toContain('worker crashed');
    expect(screen.getByText(/Engine error/)).toBeTruthy();
  });

  it('“Review this game” switches to the Review tab and starts a deep review', async () => {
    render(<PlayPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resign' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review this game' }));
    await waitFor(() => expect(reviewStart).toHaveBeenCalledWith({ depth: 14 }));
    expect(reviewReset).toHaveBeenCalled();
    expect(useUiStore.getState().activeTab).toBe('review');
  });

  it('“Review this game” keeps the automatic review of this game and only opens the tab', async () => {
    render(<PlayPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resign' }));
    reviewExtra = { status: 'running', reviewed: useGameStore.getState().moves };
    fireEvent.click(screen.getByRole('button', { name: 'Review this game' }));
    await waitFor(() => expect(useUiStore.getState().activeTab).toBe('review'));
    expect(reviewStart).not.toHaveBeenCalled();
    expect(reviewReset).not.toHaveBeenCalled();
    // A review of another game (other moves array) is replaced by a deep one.
    reviewExtra = { status: 'done', reviewed: [] };
    fireEvent.click(screen.getByRole('button', { name: 'Review this game' }));
    await waitFor(() => expect(reviewStart).toHaveBeenCalledWith({ depth: 14 }));
  });

  it('time control: grouped presets, Custom inputs (clamped), No clock', () => {
    render(<PlayPanel />);
    const select = screen.getByLabelText('Time control') as HTMLSelectElement;
    expect(select.value).toBe('none');
    const groups = Array.from(select.querySelectorAll('optgroup')).map((g) => g.label);
    expect(groups).toEqual(['Bullet', 'Blitz', 'Rapid', 'Classical']);
    expect(screen.getByRole('option', { name: '3+2 · Blitz' })).toBeTruthy();
    fireEvent.change(select, { target: { value: '3+2' } });
    expect(usePlayStore.getState().setup.timeControl).toEqual({
      initialMs: 180_000,
      incrementMs: 2000,
    });
    expect(screen.queryByLabelText('Minutes')).toBeNull();

    fireEvent.change(select, { target: { value: 'custom' } });
    expect(select.value).toBe('custom');
    const minutes = screen.getByLabelText('Minutes') as HTMLInputElement;
    expect(minutes.value).toBe('3');
    fireEvent.change(minutes, { target: { value: '0.25' } });
    fireEvent.change(screen.getByLabelText('Increment (s)'), { target: { value: '0' } });
    expect(usePlayStore.getState().setup.timeControl).toEqual({
      initialMs: 15_000,
      incrementMs: 0,
    });
    expect(screen.getByText('0.25+0 · UltraBullet')).toBeTruthy();
    // Out of range: committed clamped on blur.
    fireEvent.change(minutes, { target: { value: '500' } });
    fireEvent.blur(minutes);
    expect(usePlayStore.getState().setup.timeControl?.initialMs).toBe(180 * 60_000);
    expect(minutes.value).toBe('180');
    // A custom value that equals a preset stays "Custom" while editing.
    fireEvent.change(minutes, { target: { value: '5' } });
    expect(select.value).toBe('custom');

    fireEvent.change(select, { target: { value: 'none' } });
    expect(usePlayStore.getState().setup.timeControl).toBeNull();
    expect(screen.queryByLabelText('Minutes')).toBeNull();
  });

  it('playing with a clock: engine clock in the top bar, yours below; lost on time', () => {
    usePlayStore.setState({
      setup: {
        color: 'white',
        strength: '1500',
        moveTime: 500,
        timeControl: { initialMs: 60_000, incrementMs: 0 },
      },
    });
    render(
      <>
        <PlayPanel />
        <Bars />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    const clocks = screen.getAllByRole('timer');
    expect(clocks.map((c) => c.getAttribute('data-testid'))).toEqual([
      'play-clock-engine',
      'play-clock-you',
    ]);
    expect(clocks[0]!.getAttribute('aria-label')).toBe('Black clock 1:00');
    expect(clocks[1]!.getAttribute('aria-label')).toBe('White clock 1:00');
    expect(clocks[1]!.getAttribute('data-state')).toBe('running');
    expect(clocks[0]!.getAttribute('data-state')).toBe('idle');
    expect(screen.getByText(/1\+0 · Bullet/)).toBeTruthy();
    expect(screen.getByTestId('player-bar-top').getAttribute('aria-label')).toBe(
      'Black: Stockfish · 1500 Elo, 1:00',
    );
    expect(screen.getByTestId('player-bar-bottom').getAttribute('aria-label')).toBe(
      'White: You, 1:00',
    );

    act(() => usePlayStore.getState().tick(performance.now() + 120_000));
    expect(screen.getByTestId('play-verdict').textContent).toBe('You lost on time');
    expect(screen.getByTestId('play-result').textContent).toBe('0-1');
    expect(screen.getByTestId('play-clock-you').textContent).toBe('0:00.0');
    expect(screen.getByTestId('play-clock-you').getAttribute('data-state')).toBe('flagged');
  });

  it('“Engine lost on time” when the engine flags', () => {
    usePlayStore.setState({
      mode: 'finished',
      playerColor: 'black',
      result: '0-1',
      reason: 'timeout',
    });
    render(<PlayPanel />);
    expect(screen.getByTestId('play-verdict').textContent).toBe('Engine lost on time');
    expect(screen.queryByText(/Time out/)).toBeNull();
  });

  it('Start is disabled with the reason while a live game runs', () => {
    useLiveStore.setState({ status: 'playing' });
    try {
      render(<PlayPanel />);
      const start = screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
      expect(start.disabled).toBe(true);
      expect(screen.getByText(/A live game is running/)).toBeTruthy();
      expect(start.getAttribute('aria-describedby')).toBeTruthy();
    } finally {
      useLiveStore.setState({ status: 'idle' });
    }
  });
});

describe('PlayPanel play from the current position', () => {
  it('the “Current position” option is disabled at the start position without moves', () => {
    render(<PlayPanel />);
    expect(
      (screen.getByRole('radio', { name: 'Current position' }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Play or load some moves first/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Play from here' })).toBeNull();
  });

  it('Start with “Current position” keeps the moves', async () => {
    useGameStore.getState().loadPgn('1. e4 e5');
    render(<PlayPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'Current position' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(usePlayStore.getState().mode).toBe('playing');
    expect(usePlayStore.getState().fromPly).toBe(2);
    expect(useGameStore.getState().moves).toHaveLength(2);
    expect(takeBack().disabled).toBe(true); // opening moves are not taken back
  });

  it('“Play from here” on the idle and finished states; the review sees all plies', async () => {
    useGameStore.getState().loadPgn('1. e4 e5');
    render(<PlayPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Play from here' }));
    expect(usePlayStore.getState().mode).toBe('playing');
    act(() => {
      useGameStore.getState().makeMove('g1', 'f3');
    });
    await waitFor(() => expect(useGameStore.getState().moves).toHaveLength(4));
    fireEvent.click(screen.getByRole('button', { name: 'Resign' }));
    let plies = 0;
    reviewStart.mockImplementationOnce(() => {
      plies = useGameStore.getState().moves.length;
      return Promise.resolve(undefined);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review this game' }));
    await waitFor(() => expect(reviewStart).toHaveBeenCalled());
    expect(plies).toBe(4); // opening line + the played-out part
    expect(
      useGameStore
        .getState()
        .moves.slice(0, 2)
        .map((m) => m.san),
    ).toEqual(['e4', 'e5']);
    expect(screen.getByRole('button', { name: 'Play from here' })).toBeTruthy();
  });
});

describe('PlayPanel: human-like opponents (Maia, M23-2)', () => {
  let server: FakeMaiaServer;
  let probes = 0;
  const setProbe = (serverProbe: ServerProbeState) =>
    act(() => useAnalysisStore.setState({ serverProbe }));
  const strength = () => screen.getByLabelText('Strength') as HTMLSelectElement;
  const option = (label: RegExp) =>
    [...strength().options].find((o) => label.test(o.textContent ?? '')) as HTMLOptionElement;

  beforeEach(async () => {
    server = new FakeMaiaServer();
    probes = 0;
    setHumanProbe(() => probes++);
    await configurePlay({
      createEngine: () => engine,
      createHumanEngine: (ctx) =>
        new MaiaOpponent({
          engineId: ctx.engineId,
          createClient: () => server.client(ctx.engineId),
          varyMoves: ctx.varyMoves,
          wait: () => Promise.resolve(),
        }),
      extraDelayMs: () => 0,
      random: () => 0.1,
    });
  });

  afterEach(() => {
    setHumanProbe(() => undefined);
    useAnalysisStore.setState({ serverProbe: { status: 'idle' } });
  });

  it('lists Maia 1100–1900 in a "Human-like (server)" group and probes the server', () => {
    render(<PlayPanel />);
    const groups = [...strength().querySelectorAll('optgroup')].map((g) => g.label);
    expect(groups).toEqual(['Stockfish (browser)', 'Human-like (server)']);
    const human = [...strength().querySelectorAll('optgroup')[1]!.querySelectorAll('option')];
    expect(human.map((o) => o.value)).toEqual([
      'maia-1100',
      'maia-1200',
      'maia-1300',
      'maia-1400',
      'maia-1500',
      'maia-1600',
      'maia-1700',
      'maia-1800',
      'maia-1900',
    ]);
    expect(probes).toBeGreaterThan(0);
  });

  it('without the token the Maia options are disabled with "No server access token on this device — enter it in Settings"', () => {
    render(<PlayPanel />);
    setProbe({ status: 'error', error: 'Access token required or wrong', lastProbe: 1 });
    expect(option(/Maia 1500/).disabled).toBe(true);
    expect(option(/Maia 1500/).title).toBe('No server access token on this device — enter it in Settings');
    expect(screen.getByTestId('maia-unavailable').textContent).toBe(
      'Human-like (Maia): No server access token on this device — enter it in Settings',
    );
    expect(option(/1500 Elo/).disabled).toBe(false);
  });

  it('a server that is not reachable gives "Server unavailable"', () => {
    render(<PlayPanel />);
    setProbe({ status: 'error', error: 'Server unreachable', lastProbe: 1 });
    expect(option(/Maia 1900/).disabled).toBe(true);
    expect(screen.getByTestId('maia-unavailable').textContent).toContain('Server unavailable');
  });

  it('while the probe runs nothing is disabled or shown; a reset probe is requested again', () => {
    render(<PlayPanel />);
    setProbe({ status: 'probing' });
    expect(option(/Maia 1500/).disabled).toBe(false);
    expect(screen.queryByTestId('maia-unavailable')).toBeNull();
    const before = probes;
    setProbe({ status: 'ok', engines: MAIA_WELCOME.engines, lastProbe: 1 });
    setProbe({ status: 'idle' });
    expect(probes).toBeGreaterThan(before);
  });

  it('selecting Maia persists it, shows "Vary moves" instead of the thinking time', () => {
    render(<PlayPanel />);
    setProbe({ status: 'ok', engines: MAIA_WELCOME.engines, lastProbe: 1 });
    fireEvent.change(strength(), { target: { value: 'maia-1100' } });
    expect(usePlayStore.getState().setup.strength).toBe('maia-1100');
    expect(JSON.parse(localStorage.getItem('daisychess.play')!).strength).toBe('maia-1100');
    expect(screen.queryByLabelText('Thinking time')).toBeNull();
    const vary = screen.getByRole('checkbox', { name: 'Vary moves' }) as HTMLInputElement;
    expect(vary.checked).toBe(true);
    fireEvent.click(vary);
    expect(usePlayStore.getState().setup.varyMoves).toBe(false);
    // A level the server does not list is disabled.
    expect(option(/Maia 1300/).disabled).toBe(true);
    expect(option(/Maia 1300/).title).toBe('Not offered by the server');
  });

  it('a game vs Maia 1500: legal reply, bar "Maia 1500 · human-like"', async () => {
    server.replies = [{ kind: 'move', best: 'e7e5', policy: [{ uci: 'e7e5', p: 0.7 }] }];
    render(
      <>
        <PlayPanel />
        <Bars />
      </>,
    );
    setProbe({ status: 'ok', engines: MAIA_WELCOME.engines, lastProbe: 1 });
    fireEvent.change(strength(), { target: { value: 'maia-1500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(screen.getByText(/White · Maia 1500 · No clock · human-like/)).toBeTruthy();
    expect(screen.getByTestId('player-bar-top').getAttribute('aria-label')).toBe(
      'Black: Maia 1500 · human-like',
    );
    act(() => {
      useGameStore.getState().makeMove('e2', 'e4');
    });
    await waitFor(() => expect(useGameStore.getState().moves).toHaveLength(2));
    expect(useGameStore.getState().moves[1]!.san).toBe('e5');
    expect(engine.searches).toHaveLength(0);
  });

  it('Maia busy: the game ends with the message and offers "Continue vs Stockfish"', async () => {
    server.replies = [{ kind: 'busy' }];
    render(<PlayPanel />);
    setProbe({ status: 'ok', engines: MAIA_WELCOME.engines, lastProbe: 1 });
    fireEvent.change(strength(), { target: { value: 'maia-1500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    act(() => {
      useGameStore.getState().makeMove('e2', 'e4');
    });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Maia is busy, try again'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue vs Stockfish' }));
    expect(usePlayStore.getState()).toMatchObject({ mode: 'playing', setup: { strength: '1500' } });
    await waitFor(() => expect(useGameStore.getState().moves).toHaveLength(2));
    expect(engine.searches).toHaveLength(1);
  });

  it('a known missing token refuses Start with the reason', () => {
    render(<PlayPanel />);
    setProbe({ status: 'ok', engines: MAIA_WELCOME.engines, lastProbe: 1 });
    fireEvent.change(strength(), { target: { value: 'maia-1500' } });
    setProbe({ status: 'error', error: 'Access token required or wrong', lastProbe: 2 });
    // The selected level stays selected (and shown) but the game does not start.
    expect(strength().value).toBe('maia-1500');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(usePlayStore.getState().mode).toBe('idle');
    expect(screen.getByText('Maia 1500 cannot play: No server access token on this device — enter it in Settings.')).toBeTruthy();
  });
});
