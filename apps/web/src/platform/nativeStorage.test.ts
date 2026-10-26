// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { PreferencesPort } from './native';
import { installStorageMirror, restoreFromPreferences } from './nativeStorage';

function prefsOf(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  const port: PreferencesPort = {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
  };
  return { data, port };
}

const store = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

describe('native storage mirror', () => {
  it('restores purged keys from the preferences', async () => {
    const s = store();
    const p = prefsOf({ a: '1', b: '2' });
    expect(await restoreFromPreferences(s, p.port, ['a', 'b', 'c'])).toEqual(['a', 'b']);
    expect(s.m.get('a')).toBe('1');
    expect(s.m.has('c')).toBe(false);
  });

  it('keeps localStorage when both exist and backfills the mirror', async () => {
    const s = store({ a: 'local', b: 'only-local' });
    const p = prefsOf({ a: 'stale' });
    expect(await restoreFromPreferences(s, p.port, ['a', 'b'])).toEqual([]);
    expect(s.m.get('a')).toBe('local');
    expect(p.data.get('a')).toBe('local');
    expect(p.data.get('b')).toBe('only-local');
  });

  it('mirrors writes and removals of the listed keys of that storage only', async () => {
    const p = prefsOf();
    const proto = Storage.prototype;
    const off = installStorageMirror(proto, localStorage, p.port, ['k']);
    try {
      localStorage.setItem('k', 'v');
      localStorage.setItem('other', 'x');
      sessionStorage.setItem('k', 'session');
      await Promise.resolve();
      expect(p.data.get('k')).toBe('v');
      expect(p.data.has('other')).toBe(false);
      localStorage.removeItem('k');
      await Promise.resolve();
      expect(p.data.has('k')).toBe(false);
      expect(localStorage.getItem('other')).toBe('x');
    } finally {
      off();
      localStorage.clear();
      sessionStorage.clear();
    }
  });
});
