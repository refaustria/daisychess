// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBack, resetBackButton, trackTabHistory } from '../../platform/backButton';
import { useAnalysisStore } from '../../store/analysisStore';
import { useGameStore } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { BottomTabs, currentPgn, OptionsButton, phoneTabLabelId } from './PhoneChrome';

let stop: () => void;
const originalSetEnabled = useAnalysisStore.getState().setEnabled;

beforeEach(() => {
  useUiStore.setState({ activeTab: 'moves' });
  useGameStore.getState().reset();
  useAnalysisStore.setState({
    enabled: false,
    setEnabled: (enabled: boolean) => useAnalysisStore.setState({ enabled }),
  });
  resetBackButton();
  stop = trackTabHistory();
});

afterEach(() => {
  stop();
  cleanup();
  useAnalysisStore.setState({ setEnabled: originalSetEnabled });
});

const tab = (name: string) => screen.getByRole('tab', { name });
const more = () => screen.getByRole('button', { name: /^More/ });

describe('BottomTabs', () => {
  it('five primary tabs with WAI-ARIA tab semantics and a More button', () => {
    render(<BottomTabs />);
    const list = screen.getByRole('tablist', { name: 'Game panels' });
    expect(list.closest('nav')?.getAttribute('aria-label')).toBe('Panels');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Analysis',
      'Play',
      'Puzzles',
      'Review',
      'Openings',
    ]);
    expect(tab('Analysis').getAttribute('aria-selected')).toBe('true');
    expect(tab('Analysis').getAttribute('aria-controls')).toBe('tabpanel-main');
    expect(tab('Analysis').tabIndex).toBe(0);
    expect(tab('Play').tabIndex).toBe(-1);
    expect(more().getAttribute('aria-haspopup')).toBe('dialog');
    expect(more().getAttribute('aria-expanded')).toBe('false');
  });

  it('arrow keys, Home and End move between the primary tabs and activate them', () => {
    render(<BottomTabs />);
    tab('Analysis').focus();
    fireEvent.keyDown(tab('Analysis'), { key: 'ArrowRight' });
    expect(useUiStore.getState().activeTab).toBe('play');
    expect(document.activeElement).toBe(tab('Play'));
    fireEvent.keyDown(tab('Play'), { key: 'End' });
    expect(useUiStore.getState().activeTab).toBe('openings');
    fireEvent.keyDown(tab('Openings'), { key: 'ArrowRight' });
    expect(useUiStore.getState().activeTab).toBe('moves');
    fireEvent.keyDown(tab('Analysis'), { key: 'ArrowLeft' });
    expect(useUiStore.getState().activeTab).toBe('openings');
    fireEvent.keyDown(tab('Openings'), { key: 'Home' });
    expect(useUiStore.getState().activeTab).toBe('moves');
  });

  it('More opens a sheet with the other panels; choosing one selects it', () => {
    render(<BottomTabs />);
    fireEvent.click(more());
    const sheet = screen.getByRole('dialog', { name: 'More' });
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(more().getAttribute('aria-expanded')).toBe('true');
    const items = ['Live', 'Friend', 'Import', 'Explorer', 'Settings'];
    expect(Array.from(sheet.querySelectorAll('button')).map((b) => b.textContent)).toEqual(items);
    // Focus moves into the sheet.
    expect(document.activeElement?.textContent).toBe('Live');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useUiStore.getState().activeTab).toBe('settings');
    expect(screen.queryByRole('dialog')).toBeNull();
    // The More button stands for the open panel; no primary tab is selected.
    expect(more().getAttribute('aria-label')).toBe('More, Settings open');
    expect(more().textContent).toBe('Settings');
    expect(
      screen.getAllByRole('tab').every((t) => t.getAttribute('aria-selected') === 'false'),
    ).toBe(true);
    // The first tab keeps the tab stop.
    expect(tab('Analysis').tabIndex).toBe(0);
    fireEvent.click(more());
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('Escape, a tap outside, a tab change and the back button close the sheet', () => {
    render(<BottomTabs />);
    fireEvent.click(more());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(more());

    fireEvent.click(more());
    fireEvent.click(screen.getByTestId('more-scrim'));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(more());
    act(() => useUiStore.getState().setActiveTab('puzzles'));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Android back: the sheet is the topmost layer; then the tab history.
    fireEvent.click(more());
    let r: string | undefined;
    act(() => {
      r = handleBack();
    });
    expect(r).toBe('dialog');
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => {
      r = handleBack();
    });
    expect(r).toBe('tab');
    expect(useUiStore.getState().activeTab).toBe('moves');
  });

  it('Tab cycles inside the sheet', () => {
    render(<BottomTabs />);
    fireEvent.click(more());
    const buttons = Array.from(screen.getByRole('dialog').querySelectorAll('button'));
    buttons[buttons.length - 1]!.focus();
    fireEvent.keyDown(buttons[buttons.length - 1]!, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0]!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('phoneTabLabelId: a primary tab, or the More button', () => {
    expect(phoneTabLabelId('review')).toBe('tab-review');
    expect(phoneTabLabelId('explorer')).toBe('tab-more');
  });
});

describe('OptionsButton', () => {
  const options = () => screen.getByRole('button', { name: 'Options' });

  it('copies FEN and PGN, flips, undoes, starts a new game; engine switch inside', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    act(() => {
      useGameStore.getState().makeMove('e2', 'e4');
    });
    render(<OptionsButton />);
    fireEvent.click(options());
    const menu = screen.getByRole('dialog', { name: 'Options' });
    expect(options().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.textContent).toBe('Copy FEN');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy FEN' }));
    });
    expect(writeText).toHaveBeenLastCalledWith(
      expect.stringMatching(/^rnbqkbnr\/pppppppp\/8\/8\/4P3\/8\/PPPP1PPP\/RNBQKBNR b KQkq/),
    );
    expect(screen.getByRole('button', { name: 'FEN copied' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy PGN' }));
    });
    expect(writeText).toHaveBeenLastCalledWith(currentPgn());
    expect(currentPgn()).toContain('1. e4');

    const sw = screen.getByRole('switch', { name: 'Engine' }) as HTMLInputElement;
    expect(menu.contains(sw)).toBe(true);
    fireEvent.click(sw);
    expect(useAnalysisStore.getState().enabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Flip board' }));
    expect(useGameStore.getState().orientation).toBe('black');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(options());
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(useGameStore.getState().moves).toHaveLength(0);
    fireEvent.click(options());
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      useGameStore.getState().makeMove('d2', 'd4');
    });
    fireEvent.click(screen.getByRole('button', { name: 'New game' }));
    expect(useGameStore.getState().moves).toHaveLength(0);
  });

  it('reports a missing clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    render(<OptionsButton />);
    fireEvent.click(options());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy FEN' }));
    });
    expect(screen.getByRole('status').textContent).toBe('Copying is not available here.');
  });

  it('closes with Escape, a tap outside and the back button', () => {
    render(<OptionsButton />);
    fireEvent.click(options());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(options());
    fireEvent.click(options());
    fireEvent.click(screen.getByTestId('options-scrim'));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(options());
    let r: string | undefined;
    act(() => {
      r = handleBack();
    });
    expect(r).toBe('dialog');
    expect(screen.queryByRole('dialog')).toBeNull();
    // Nothing left to close on the home tab: the app would exit.
    expect(handleBack()).toBe('exit');
  });
});
