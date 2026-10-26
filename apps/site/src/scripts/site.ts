// Runs on every page: marks JS as available and wires the mobile navigation toggle. The button's
// name stays "Menu"; aria-expanded carries the state.
import { initThemeToggle } from './theme';

export function initNav(doc: Document = document): void {
  const toggle = doc.querySelector<HTMLButtonElement>('.nav-toggle');
  const nav = doc.getElementById('site-nav');
  if (!toggle || !nav) return;
  toggle.hidden = false;
  const set = (open: boolean) => {
    toggle.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('is-open', open);
  };
  toggle.addEventListener('click', () => set(toggle.getAttribute('aria-expanded') !== 'true'));
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      set(false);
      toggle.focus();
    }
  });
  // Close after following an in-page link.
  nav.addEventListener('click', (e) => {
    if ((e.target as HTMLElement | null)?.closest('a')) set(false);
  });
}

export function initSite(doc: Document = document): void {
  doc.documentElement.classList.remove('no-js');
  doc.documentElement.classList.add('js');
  initNav(doc);
  initThemeToggle(doc);
}
