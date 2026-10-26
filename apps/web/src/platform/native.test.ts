// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
vi.mock('@capacitor/haptics', () => ({
  ImpactStyle: { Light: 'L', Medium: 'M', Heavy: 'H' },
  NotificationType: { Success: 'S', Warning: 'W', Error: 'E' },
  Haptics: {
    impact: async (o: { style: string }) => void calls.push(`impact:${o.style}`),
    notification: async (o: { type: string }) => void calls.push(`note:${o.type}`),
  },
}));
vi.mock('@capacitor-community/keep-awake', () => ({
  KeepAwake: {
    keepAwake: async () => void calls.push('awake'),
    allowSleep: async () => void calls.push('sleep'),
  },
}));
vi.mock('@capacitor/status-bar', () => ({
  Style: { Dark: 'DARK', Light: 'LIGHT' },
  StatusBar: { setStyle: async (o: { style: string }) => void calls.push(`bar:${o.style}`) },
}));
vi.mock('@capacitor/preferences', () => {
  const m = new Map<string, string>();
  return {
    Preferences: {
      get: async ({ key }: { key: string }) => ({ value: m.get(key) ?? null }),
      set: async ({ key, value }: { key: string; value: string }) => void m.set(key, value),
      remove: async ({ key }: { key: string }) => void m.delete(key),
    },
  };
});

import { loadAppState, loadHaptics, loadKeepAwake, loadPreferences, loadStatusBar } from './native';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  calls.length = 0;
});

function asApp() {
  vi.stubEnv('MODE', 'mobile');
  vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'ios' });
}

describe('plugin loaders', () => {
  it('return null on the web (and for a page that only fakes the global)', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'ios' });
    expect(await loadHaptics()).toBeNull();
    expect(await loadKeepAwake()).toBeNull();
    expect(await loadStatusBar()).toBeNull();
    expect(await loadPreferences()).toBeNull();
    expect(await loadAppState()).toBeNull();
  });

  it('adapt the plugins in the app', async () => {
    asApp();
    const h = await loadHaptics();
    await h?.impact('heavy');
    await h?.notify('error');
    const k = await loadKeepAwake();
    await k?.keepAwake();
    await k?.allowSleep();
    const bar = await loadStatusBar();
    await bar?.setTheme('dark');
    await bar?.setTheme('light');
    expect(calls).toEqual(['impact:H', 'note:E', 'awake', 'sleep', 'bar:DARK', 'bar:LIGHT']);
    const p = await loadPreferences();
    await p?.set('a', '1');
    expect(await p?.get('a')).toBe('1');
    await p?.remove('a');
    expect(await p?.get('a')).toBeNull();
  });
});
