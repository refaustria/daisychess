import { vi } from 'vitest';

/**
 * Test helper: a controllable `window.matchMedia` (jsdom has none). Only `query` matches (while
 * `matches` is true); every other query (e.g. prefers-color-scheme) does not.
 */
export function mockMatchMedia(query: string, initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const original = window.matchMedia;
  window.matchMedia = vi.fn((q: string) => ({
    get matches() {
      return q === query && matches;
    },
    media: q,
    onchange: null,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    addListener: (l: () => void) => listeners.add(l),
    removeListener: (l: () => void) => listeners.delete(l),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      listeners.forEach((l) => l());
    },
    listeners: () => listeners.size,
    restore() {
      window.matchMedia = original;
    },
  };
}
