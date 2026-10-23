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
});
