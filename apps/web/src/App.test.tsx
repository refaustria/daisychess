// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('chessground', () => ({
  Chessground: vi.fn(() => ({ set: vi.fn(), redrawAll: vi.fn(), destroy: vi.fn() })),
}));
vi.mock('chessground/assets/chessground.base.css', () => ({}));
vi.mock('chessground/assets/chessground.cburnett.css', () => ({}));

import { App } from './App';
import { useGameStore } from './store/gameStore';
import { useUiStore } from './store/uiStore';

beforeEach(() => useGameStore.getState().reset());

describe('App', () => {
  it('renders title, controls and status', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'DaisyChess' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New game' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Flip' })).toBeTruthy();
    expect(screen.getByTestId('status').textContent).toBe('White to move');
  });

  it('updates status and responds to keyboard navigation', () => {
    render(<App />);
    const s = useGameStore.getState();
    act(() => {
      for (const [f, t] of [
        ['f2', 'f3'],
        ['e7', 'e5'],
        ['g2', 'g4'],
        ['d8', 'h4'],
      ] as const) {
        s.makeMove(f, t);
      }
    });
    expect(screen.getByTestId('status').textContent).toBe('Checkmate — Black wins');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(useGameStore.getState().ply).toBe(3);
    fireEvent.keyDown(window, { key: 'Home' });
    expect(useGameStore.getState().ply).toBe(0);
    fireEvent.keyDown(window, { key: 'End' });
    expect(useGameStore.getState().ply).toBe(4);
    expect((screen.getByLabelText('FEN') as HTMLInputElement).value).toContain('rnb1kbnr');
  });

  it('player bars above and below the board follow the orientation', () => {
    render(<App />);
    expect(screen.getByTestId('player-bar-top').getAttribute('aria-label')).toBe('Black: Black');
    expect(screen.getByTestId('player-bar-bottom').getAttribute('aria-label')).toBe('White: White');
    fireEvent.click(screen.getByRole('button', { name: 'Flip' }));
    expect(screen.getByTestId('player-bar-top').getAttribute('aria-label')).toBe('White: White');
    expect(screen.getByTestId('player-bar-bottom').getAttribute('aria-label')).toBe('Black: Black');
  });

  it('tab row: one tablist, roving tabindex, arrow keys, active tab scrolled into view', () => {
    useUiStore.setState({ activeTab: 'moves' });
    render(<App />);
    const list = screen.getByRole('tablist', { name: 'Game panels' });
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(9);
    expect(tabs.filter((t) => t.tabIndex === 0)).toHaveLength(1);
    // Layout of a narrow panel: 9 tabs of 60px in a 200px wide row (jsdom has no layout).
    const define = (el: HTMLElement, props: Record<string, number>) => {
      for (const [k, v] of Object.entries(props))
        Object.defineProperty(el, k, { configurable: true, value: v });
    };
    define(list, { clientWidth: 200 });
    tabs.forEach((t, i) => define(t, { offsetLeft: i * 60, offsetWidth: 60 }));
    list.scrollLeft = 0;
    fireEvent.keyDown(tabs[0]!, { key: 'End' });
    const settings = screen.getByRole('tab', { name: 'Settings' });
    expect(settings.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(settings);
    expect(list.scrollLeft).toBe(8 * 60 + 60 - 200);
    fireEvent.keyDown(settings, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Moves' }).getAttribute('aria-selected')).toBe('true');
    expect(list.scrollLeft).toBe(0);
  });
});
afterEach(cleanup);
