// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applySettings,
  DEFAULT_SETTINGS,
  parseSettings,
  SETTINGS_KEY,
  useSettingsStore,
} from './settingsStore';

const root = document.documentElement;
const stored = () => JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  root.removeAttribute('style');
  useSettingsStore.getState().reset();
  localStorage.clear();
});

describe('settingsStore', () => {
  it('has sensible defaults', () => {
    const s = useSettingsStore.getState();
    expect(s.boardTheme).toBe('brown');
    expect(s.pieceSet).toBe('cburnett');
    expect(s.coordinates).toBe(true);
    expect(s.highlightStyle).toBe('classic');
    expect(s.sound).toBe(true);
    expect(s.autoReview).toBe(true);
    expect(s.reviewTour).toBe(true);
    expect(parseSettings(JSON.stringify({ reviewTour: false })).reviewTour).toBe(false);
  });

  it('parses and persists autoReview', () => {
    expect(parseSettings(JSON.stringify({ autoReview: false })).autoReview).toBe(false);
    expect(parseSettings(JSON.stringify({ autoReview: 'no' })).autoReview).toBe(true);
    useSettingsStore.getState().set({ autoReview: false });
    expect(stored()).toMatchObject({ autoReview: false });
  });

  it('parses and persists premoves (default single)', () => {
    expect(useSettingsStore.getState().premoves).toBe('single');
    expect(parseSettings(JSON.stringify({ premoves: 'queue' })).premoves).toBe('queue');
    expect(parseSettings(JSON.stringify({ premoves: 'many' })).premoves).toBe('single');
    useSettingsStore.getState().set({ premoves: 'none' });
    expect(stored()).toMatchObject({ premoves: 'none' });
  });

  it('persists changes under daisychess.settings', () => {
    useSettingsStore.getState().set({ boardTheme: 'blue', coordinates: false });
    expect(stored()).toMatchObject({ boardTheme: 'blue', coordinates: false });
  });

  it('parses stored values and rejects invalid ones', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('not json')).toEqual(DEFAULT_SETTINGS);
    const p = parseSettings(
      JSON.stringify({
        boardTheme: 'nope',
        pieceSet: 'letters',
        highlightStyle: 'x',
        sound: false,
      }),
    );
    expect(p.boardTheme).toBe('brown');
    expect(p.pieceSet).toBe('letters');
    expect(p.highlightStyle).toBe('classic');
    expect(p.sound).toBe(false);
    expect(
      parseSettings(
        JSON.stringify({ boardTheme: 'custom', customBoard: { light: '#ffffff', dark: 'red' } }),
      ).boardTheme,
    ).toBe('brown');
  });

  it('stores the server access token trimmed and keeps it on reset', () => {
    expect(useSettingsStore.getState().serverToken).toBe('');
    useSettingsStore.getState().setServerToken('  abc123 \n');
    expect(useSettingsStore.getState().serverToken).toBe('abc123');
    expect(stored()).toMatchObject({ serverToken: 'abc123' });
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().serverToken).toBe('abc123');
    expect(
      parseSettings(JSON.stringify({ serverToken: 'x'.repeat(300) })).serverToken,
    ).toHaveLength(256);
    expect(parseSettings(JSON.stringify({ serverToken: 42 })).serverToken).toBe('');
    useSettingsStore.getState().setServerToken('');
    expect(stored()).toMatchObject({ serverToken: '' });
  });

  it('review engine: defaults to auto, persists, parses defensively, survives reset', () => {
    expect(DEFAULT_SETTINGS.reviewEngine).toBe('auto');
    expect(useSettingsStore.getState().reviewEngine).toBe('auto');
    useSettingsStore.getState().set({ reviewEngine: 'server' });
    expect(stored()).toMatchObject({ reviewEngine: 'server' });
    expect(parseSettings(localStorage.getItem(SETTINGS_KEY)).reviewEngine).toBe('server');
    expect(parseSettings(JSON.stringify({ reviewEngine: 'browser' })).reviewEngine).toBe('browser');
    expect(parseSettings(JSON.stringify({ reviewEngine: 'cloud' })).reviewEngine).toBe('auto');
    expect(parseSettings(JSON.stringify({ reviewEngine: 1 })).reviewEngine).toBe('auto');
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().reviewEngine).toBe('server');
    useSettingsStore.getState().set({ reviewEngine: 'auto' });
  });

  it('applies board colours as CSS variables and tracks changes', () => {
    const stop = applySettings();
    expect(root.style.getPropertyValue('--board-light')).toBe('');
    useSettingsStore.getState().set({ boardTheme: 'blue' });
    expect(root.style.getPropertyValue('--board-light')).toBe('#dee3e6');
    expect(root.style.getPropertyValue('--board-dark')).toBe('#8ca2ad');
    useSettingsStore.getState().setCustomBoard({ light: '#111111', dark: '#222222' });
    expect(useSettingsStore.getState().boardTheme).toBe('custom');
    expect(root.style.getPropertyValue('--board-light')).toBe('#111111');
    useSettingsStore.getState().reset();
    expect(root.style.getPropertyValue('--board-light')).toBe('');
    stop();
  });

  it('reset restores defaults and persists them', () => {
    useSettingsStore.getState().set({ pieceSet: 'letters', sound: false });
    useSettingsStore.getState().reset();
    expect(useSettingsStore.getState()).toMatchObject(DEFAULT_SETTINGS);
    expect(stored()).toMatchObject(DEFAULT_SETTINGS);
    expect(stored().customBoard).toBeUndefined();
  });
});
