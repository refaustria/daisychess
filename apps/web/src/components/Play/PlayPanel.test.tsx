// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reviewStart = vi.fn(() => Promise.resolve(undefined));
const reviewReset = vi.fn();
vi.mock('../../review/reviewStore', () => ({
  REVIEW_PRESETS: { fast: { movetime: 300 }, deep: { depth: 14 } },
  useReviewStore: { getState: () => ({ start: reviewStart, reset: reviewReset }) },
}));

import { FakePlayEngine } from '../../play/fakePlayEngine';
import { useLiveStore } from '../../live/liveStore';
import { configurePlay, resetPlay, usePlayStore } from '../../play/playStore';
import { useGameStore } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { PlayIndicator } from './PlayIndicator';
import { PlayPanel } from './PlayPanel';
import { PlayerBar, useBoardPlayers } from '../PlayerBar/PlayerBar';

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
