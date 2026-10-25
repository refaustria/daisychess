// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings, useSettingsStore } from '../../store/settingsStore';
import { SettingsPanel } from './SettingsPanel';

beforeEach(() => useSettingsStore.getState().reset());
afterEach(cleanup);

describe('human-like hint settings', () => {
  it('defaults: on, level 1500', () => {
    expect(DEFAULT_SETTINGS.maiaHints).toBe(true);
    expect(DEFAULT_SETTINGS.maiaRating).toBe(1500);
  });

  it('parses stored values defensively', () => {
    expect(parseSettings(JSON.stringify({ maiaHints: false, maiaRating: 1800 }))).toMatchObject({
      maiaHints: false,
      maiaRating: 1800,
    });
    expect(parseSettings(JSON.stringify({ maiaHints: 'no', maiaRating: 1850 }))).toMatchObject({
      maiaHints: true,
      maiaRating: 1500,
    });
    expect(parseSettings(JSON.stringify({ maiaRating: '1800' })).maiaRating).toBe(1500);
  });

  it('toggle and level select update and persist the settings', () => {
    render(<SettingsPanel />);
    const select = screen.getByLabelText('Your level for human-like hints') as HTMLSelectElement;
    expect(select.value).toBe('1500');
    expect([...select.options].map((o) => o.value)).toEqual([
      '1100', '1200', '1300', '1400', '1500', '1600', '1700', '1800', '1900',
    ]);
    fireEvent.change(select, { target: { value: '1300' } });
    expect(useSettingsStore.getState().maiaRating).toBe(1300);
    expect(JSON.parse(localStorage.getItem('daisychess.settings')!)).toMatchObject({
      maiaRating: 1300,
    });
    const toggle = screen.getByLabelText('Human-like hints in the review (Maia)') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().maiaHints).toBe(false);
    expect(select.disabled).toBe(true);
  });
});
