// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
