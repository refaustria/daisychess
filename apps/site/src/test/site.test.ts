// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { hasWebGL, prefersReducedMotion } from '../scripts/env';
import { initSite } from '../scripts/site';
import { renderHeader } from '../../build/partials';

describe('initSite / nav toggle', () => {
  beforeEach(() => {
    document.documentElement.className = 'no-js';
    document.body.innerHTML = renderHeader('home');
  });

  it('swaps no-js for js and reveals the toggle', () => {
    initSite();
    expect(document.documentElement.classList.contains('js')).toBe(true);
    expect(document.documentElement.classList.contains('no-js')).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('.nav-toggle')!.hidden).toBe(false);
  });

  it('opens and closes the menu with the button, Escape and a link click', () => {
    initSite();
    const toggle = document.querySelector<HTMLButtonElement>('.nav-toggle')!;
    const nav = document.getElementById('site-nav')!;
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(nav.classList.contains('is-open')).toBe(true);
    expect(toggle.textContent).toContain('Menu');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    toggle.click();
    nav.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(nav.classList.contains('is-open')).toBe(false);
  });

  it('does nothing without the header markup', () => {
    document.body.innerHTML = '';
    expect(() => initSite()).not.toThrow();
  });
});

describe('env', () => {
  it('reads prefers-reduced-motion', () => {
    const mm = (matches: boolean) => ({ matchMedia: () => ({ matches }) as unknown as MediaQueryList });
    expect(prefersReducedMotion(mm(true))).toBe(true);
    expect(prefersReducedMotion(mm(false))).toBe(false);
    expect(prefersReducedMotion({} as Pick<Window, 'matchMedia'>)).toBe(false);
  });

  it('detects WebGL via a probe canvas and survives exceptions', () => {
    const lose = { loseContext: () => undefined };
    const gl = { getExtension: () => lose };
    const doc = (ctx: unknown) =>
      ({ createElement: () => ({ getContext: (k: string) => (k === 'webgl' ? ctx : null) }) }) as unknown as Pick<Document, 'createElement'>;
    expect(hasWebGL(doc(gl))).toBe(true);
    expect(hasWebGL(doc(null))).toBe(false);
    const throwing = {
      createElement: () => {
        throw new Error('no canvas');
      },
    } as unknown as Pick<Document, 'createElement'>;
    expect(hasWebGL(throwing)).toBe(false);
  });
});
