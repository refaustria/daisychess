// Light/dark theme: system preference by default, explicit choice (header toggle) persisted in
// localStorage under the same key and values as the web app. /theme-init.js (public/) applies the
// stored choice before first paint; this module owns the toggle and lets the hero follow live.

export type Theme = 'light' | 'dark';
export const THEME_KEY = 'daisychess.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function systemTheme(win: Pick<Window, 'matchMedia'> = window): Theme {
  try {
    return win.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** The theme in effect: the data-theme override if set, else the system preference. */
export function effectiveTheme(doc: Document = document): Theme {
  const attr = doc.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return systemTheme(doc.defaultView ?? window);
}

export function readStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function store(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage blocked: the choice only lasts for this page view */
  }
}

/** Calls `cb` whenever the effective theme may have changed (toggle or system change). Returns a stop function. */
export function watchTheme(cb: (theme: Theme) => void, doc: Document = document): () => void {
  const win = doc.defaultView ?? window;
  const fire = () => cb(effectiveTheme(doc));
  const mq = typeof win.matchMedia === 'function' ? win.matchMedia(DARK_QUERY) : null;
  mq?.addEventListener('change', fire);
  const mo = new MutationObserver(fire);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    mq?.removeEventListener('change', fire);
    mo.disconnect();
  };
}

/** Wires the header button; it stays hidden without JavaScript (it would do nothing). */
export function initThemeToggle(doc: Document = document): void {
  const btn = doc.querySelector<HTMLButtonElement>('.theme-toggle');
  if (!btn) return;
  const stored = readStoredTheme();
  if (stored) doc.documentElement.setAttribute('data-theme', stored);
  const sync = (theme: Theme) => {
    btn.dataset.themeNow = theme;
    btn.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
    );
  };
  sync(effectiveTheme(doc));
  btn.hidden = false;
  btn.addEventListener('click', () => {
    const next: Theme = effectiveTheme(doc) === 'dark' ? 'light' : 'dark';
    doc.documentElement.setAttribute('data-theme', next);
    store(next);
    sync(next);
  });
  watchTheme(sync, doc);
}
