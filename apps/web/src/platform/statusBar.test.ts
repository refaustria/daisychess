// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectiveTheme, startStatusBarTheme } from './statusBar';

afterEach(() => document.documentElement.removeAttribute('data-theme'));

describe('status bar theme', () => {
  it('prefers the data-theme attribute, then the system scheme', () => {
    expect(effectiveTheme({ getAttribute: () => 'dark' }, () => false)).toBe('dark');
    expect(effectiveTheme({ getAttribute: () => null }, () => true)).toBe('dark');
    expect(effectiveTheme({ getAttribute: () => null }, () => false)).toBe('light');
  });

  it('follows theme changes', async () => {
    const port = { setTheme: vi.fn(() => Promise.resolve()) };
    document.documentElement.setAttribute('data-theme', 'light');
    const stop = startStatusBarTheme(port);
    expect(port.setTheme).toHaveBeenLastCalledWith('light');
    document.documentElement.setAttribute('data-theme', 'dark');
    await Promise.resolve(); // MutationObserver callbacks are microtasks
    await new Promise((r) => setTimeout(r, 0));
    expect(port.setTheme).toHaveBeenLastCalledWith('dark');
    expect(port.setTheme).toHaveBeenCalledTimes(2);
    stop();
  });
});
