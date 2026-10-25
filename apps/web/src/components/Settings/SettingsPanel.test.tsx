// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../../store/uiStore';
import { useSettingsStore } from '../../store/settingsStore';
import { SettingsPanel } from './SettingsPanel';

beforeEach(() => useSettingsStore.getState().reset());
afterEach(cleanup);

describe('SettingsPanel', () => {
  it('selecting a swatch updates the store', () => {
    render(<SettingsPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'Blue' }));
    expect(useSettingsStore.getState().boardTheme).toBe('blue');
    expect(screen.getByRole('radio', { name: 'Blue' }).getAttribute('aria-checked')).toBe('true');
  });

  it('toggles coordinates, sound, highlight style and piece set', () => {
    render(<SettingsPanel />);
    fireEvent.click(screen.getByLabelText('Show coordinates'));
    expect(useSettingsStore.getState().coordinates).toBe(false);
    fireEvent.click(screen.getByLabelText('Sound'));
    expect(useSettingsStore.getState().sound).toBe(false);
    fireEvent.click(screen.getByLabelText('Analyse games automatically after loading'));
    expect(useSettingsStore.getState().autoReview).toBe(false);
    expect(useSettingsStore.getState().reviewTour).toBe(true);
    fireEvent.click(screen.getByLabelText('Guided tour after a review'));
    expect(useSettingsStore.getState().reviewTour).toBe(false);
    fireEvent.change(screen.getByLabelText('Premoves'), { target: { value: 'queue' } });
    expect(useSettingsStore.getState().premoves).toBe('queue');
    fireEvent.change(screen.getByLabelText('Highlight style'), { target: { value: 'subtle' } });
    expect(useSettingsStore.getState().highlightStyle).toBe('subtle');
    fireEvent.change(screen.getByLabelText('Piece set'), { target: { value: 'letters' } });
    expect(useSettingsStore.getState().pieceSet).toBe('letters');
  });

  it('custom colours switch to the custom theme; reset restores defaults', () => {
    render(<SettingsPanel />);
    fireEvent.change(screen.getByLabelText('Custom light square'), {
      target: { value: '#123456' },
    });
    expect(useSettingsStore.getState().boardTheme).toBe('custom');
    expect(useSettingsStore.getState().customBoard?.light).toBe('#123456');
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(useSettingsStore.getState().boardTheme).toBe('brown');
  });

  it('server access token: hidden by default, show/hide, saved on submit', () => {
    useSettingsStore.getState().setServerToken('');
    render(<SettingsPanel />);
    const input = screen.getByLabelText('Server access token') as HTMLInputElement;
    expect(input.type).toBe('password');
    const save = screen.getByRole('button', { name: 'Save token' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: ' s3cret ' } });
    expect(useSettingsStore.getState().serverToken).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(input.type).toBe('text');
    fireEvent.click(save);
    expect(useSettingsStore.getState().serverToken).toBe('s3cret');
    expect(input.value).toBe('s3cret');
    expect(screen.getByText(/Server engines reconnect/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(input.type).toBe('password');
    useSettingsStore.getState().setServerToken('');
  });

  it('review engine select: auto by default, stores the choice', () => {
    useSettingsStore.getState().set({ reviewEngine: 'auto' });
    render(<SettingsPanel />);
    const select = screen.getByLabelText('Review engine') as HTMLSelectElement;
    expect(select.value).toBe('auto');
    expect([...select.options].map((o) => o.text)).toEqual([
      'Auto (server when available)',
      'Browser',
      'Server',
    ]);
    fireEvent.change(select, { target: { value: 'browser' } });
    expect(useSettingsStore.getState().reviewEngine).toBe('browser');
    useSettingsStore.getState().set({ reviewEngine: 'auto' });
  });
});

describe('SettingsPanel: setup link', () => {
  it('"Copy link for another device" is enabled only with a stored token; copies and warns', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    useSettingsStore.getState().setServerToken('');
    render(<SettingsPanel />);
    const copy = screen.getByRole('button', { name: 'Copy link for another device' }) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    cleanup();
    useSettingsStore.getState().setServerToken('tok en');
    render(<SettingsPanel />);
    const copy2 = screen.getByRole('button', { name: 'Copy link for another device' }) as HTMLButtonElement;
    expect(copy2.disabled).toBe(false);
    fireEvent.click(copy2);
    const warning = await screen.findByTestId('setup-link-warning');
    expect(warning.textContent).toContain('Anyone with this link can use your engine server.');
    expect(writeText).toHaveBeenCalledWith(`${location.origin}${location.pathname}#setup-token=tok%20en`);
    useSettingsStore.getState().setServerToken('');
  });

  it('focuses the token field when asked via the ui store', () => {
    useUiStore.getState().openServerTokenSettings();
    render(<SettingsPanel />);
    expect(document.activeElement).toBe(screen.getByLabelText('Server access token'));
    expect(useUiStore.getState().focusServerToken).toBe(false);
  });
});
