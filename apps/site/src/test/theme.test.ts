// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHeader } from '../../build/partials';
import { effectiveTheme, initThemeToggle, readStoredTheme, watchTheme } from '../scripts/theme';

function stubStorage(throwing = false) {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => {
      if (throwing) throw new Error('denied');
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throwing) throw new Error('denied');
      store.set(k, v);
    },
  });
  return store;
}

function stubMatchMedia(dark: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: dark && q.includes('dark'),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = renderHeader('home');
  stubMatchMedia(false);
});
afterEach(() => vi.unstubAllGlobals());

describe('theme toggle', () => {
  it('follows the system preference without an override', () => {
    stubStorage();
    stubMatchMedia(true);
    expect(effectiveTheme()).toBe('dark');
    initThemeToggle();
    const btn = document.querySelector<HTMLButtonElement>('.theme-toggle')!;
    expect(btn.hidden).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Switch to light theme');
  });

  it('toggles data-theme, label and storage', () => {
    const store = stubStorage();
    initThemeToggle();
    const btn = document.querySelector<HTMLButtonElement>('.theme-toggle')!;
    expect(btn.getAttribute('aria-label')).toBe('Switch to dark theme');
    btn.click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(store.get('daisychess.theme')).toBe('dark');
    expect(btn.getAttribute('aria-label')).toBe('Switch to light theme');
    btn.click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(store.get('daisychess.theme')).toBe('light');
  });

  it('applies a stored choice and ignores junk', () => {
    const store = stubStorage();
    store.set('daisychess.theme', 'dark');
    expect(readStoredTheme()).toBe('dark');
    initThemeToggle();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    store.set('daisychess.theme', 'purple');
    expect(readStoredTheme()).toBeNull();
  });

  it('tolerates blocked storage', () => {
    stubStorage(true);
    expect(readStoredTheme()).toBeNull();
    initThemeToggle();
    document.querySelector<HTMLButtonElement>('.theme-toggle')!.click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('watchTheme reports data-theme changes', async () => {
    const seen: string[] = [];
    const stop = watchTheme((t) => seen.push(t));
    document.documentElement.setAttribute('data-theme', 'dark');
    await Promise.resolve();
    stop();
    expect(seen).toEqual(['dark']);
  });
});
