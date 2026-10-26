/**
 * Status-bar style follows the DaisyChess theme (M26-4): the explicit `data-theme` attribute of
 * the root element (ThemeToggle, index.html) or, without one, the system colour scheme. No-op on
 * the web.
 */
import { loadStatusBar, type StatusBarPort } from './native';

export type Theme = 'light' | 'dark';

export function effectiveTheme(
  root: Pick<HTMLElement, 'getAttribute'> = document.documentElement,
  prefersDark: () => boolean = () =>
    globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
): Theme {
  const attr = root.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  try {
    return prefersDark() ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Applies the theme now and on every change. Returns the stop function. */
export function startStatusBarTheme(port: StatusBarPort): () => void {
  let last: Theme | null = null;
  const apply = () => {
    const t = effectiveTheme();
    if (t === last) return;
    last = t;
    void port.setTheme(t).catch(() => undefined);
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', apply);
  return () => {
    observer.disconnect();
    mq?.removeEventListener?.('change', apply);
  };
}

export async function installStatusBarTheme(): Promise<(() => void) | null> {
  const port = await loadStatusBar();
  return port ? startStatusBarTheme(port) : null;
}
