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
import { configurePlay, resetPlay, usePlayStore } from '../../play/playStore';
import { useGameStore } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { PlayIndicator } from './PlayIndicator';
import { PlayPanel } from './PlayPanel';

let engine: FakePlayEngine;
const takeBack = () => screen.getByRole('button', { name: 'Take back' }) as HTMLButtonElement;

beforeEach(async () => {
  engine = new FakePlayEngine();
  await configurePlay({ createEngine: () => engine, extraDelayMs: () => 0, random: () => 0.1 });
  usePlayStore.setState({ setup: { color: 'white', strength: '1500', moveTime: 500 } });
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
});
