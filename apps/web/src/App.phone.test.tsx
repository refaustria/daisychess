// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('chessground', () => ({
  Chessground: vi.fn(() => ({ set: vi.fn(), redrawAll: vi.fn(), destroy: vi.fn() })),
}));
vi.mock('chessground/assets/chessground.base.css', () => ({}));
vi.mock('chessground/assets/chessground.cburnett.css', () => ({}));

import { App } from './App';
import { PHONE_QUERY } from './components/PhoneLayout/usePhoneLayout';
import { useGameStore } from './store/gameStore';
import { useUiStore } from './store/uiStore';
import { mockMatchMedia } from './test/matchMedia';

let mq: ReturnType<typeof mockMatchMedia>;

beforeEach(() => {
  useGameStore.getState().reset();
  useUiStore.setState({ activeTab: 'moves' });
  mq = mockMatchMedia(PHONE_QUERY, true);
});

afterEach(() => {
  cleanup();
  mq.restore();
});

describe('App, phone portrait (M29-6)', () => {
  it('bottom tab bar, action bar and ⋯ menu instead of the tab row, Controls and FEN', async () => {
    const { container } = render(<App />);
    expect(container.firstElementChild?.getAttribute('data-layout')).toBe('phone');
    expect(await screen.findByTestId('action-bar')).toBeTruthy();
    expect(screen.getByTestId('bottom-tabs')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Options' })).toBeTruthy();
    expect(screen.queryByLabelText('FEN')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Flip' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Engine' })).toBeNull();
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('tab-moves');
    // The action bar sits between the board column and the scrolling panel.
    const bar = screen.getByTestId('action-bar');
    expect(bar.previousElementSibling?.contains(screen.getByTestId('board'))).toBe(true);
    expect(bar.nextElementSibling).toBe(screen.getByTestId('phone-panel'));
  });

  it('keyboard navigation still steps through the game', async () => {
    render(<App />);
    await screen.findByTestId('action-bar');
    act(() => {
      useGameStore.getState().makeMove('e2', 'e4');
    });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(useGameStore.getState().ply).toBe(0);
  });

  it('a More panel is labelled by the More button; panel duplicates carry data-phone-bar', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('tab-more');
    fireEvent.click(screen.getByRole('tab', { name: 'Puzzles' }));
    const panelStart = await within(screen.getByTestId('phone-panel')).findByRole('button', {
      name: 'Start puzzles',
    });
    // Hidden by CSS on phones (jsdom applies no styles): the bar has the visible copy.
    expect(panelStart.closest('[data-phone-bar]')).not.toBeNull();
    const bar = screen.getByTestId('action-bar');
    expect(
      within(bar).getByRole('button', { name: 'Start puzzles' }).closest('[data-phone-bar]'),
    ).toBeNull();
  });

  it('switches layouts when the media query changes (rotation)', async () => {
    render(<App />);
    await screen.findByTestId('action-bar');
    act(() => mq.set(false));
    expect(screen.queryByTestId('action-bar')).toBeNull();
    expect(screen.queryByTestId('bottom-tabs')).toBeNull();
    expect(screen.getByLabelText('FEN')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Moves' })).toBeTruthy();
  });
});
