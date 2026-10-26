/* global localStorage, document */
// Applies the visitor's stored theme choice before first paint (loaded as a blocking script in <head>;
// the CSP forbids inline scripts). Without a stored choice, CSS follows prefers-color-scheme.
// Keep the key and values in sync with src/scripts/theme.ts.
try {
  var t = localStorage.getItem('daisychess.theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch {
  /* storage blocked: system preference applies */
}
