// Build-time HTML partials for the static multi-page site: shared <head> metadata, header, footer
// and URL placeholders. Pure string functions so they can be unit-tested; vite.config.ts wires them
// into transformIndexHtml. Everything ends up as plain HTML in dist (works without JavaScript).
import {
  APP_URL,
  CONTACT_EMAIL,
  HUB_LINK_URL,
  PAGES,
  PORTAL_URL,
  REPO_URL,
  SITE_URL,
  canonicalUrl,
  type PageMeta,
} from '../site.config';

const TOKENS: Record<string, string> = {
  APP_URL,
  CONTACT_EMAIL,
  PORTAL_URL,
  HUB_LINK_URL,
  REPO_URL,
  SITE_URL,
  YEAR: '2026',
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Replaces `{{NAME}}` with the site constants; unknown names are an error (typos fail the build). */
export function replaceTokens(html: string): string {
  return html.replace(/\{\{([A-Z_]+)\}\}/g, (_m, name: string) => {
    const v = TOKENS[name];
    if (v === undefined) throw new Error(`unknown template token {{${name}}}`);
    return v;
  });
}

export function renderHead(page: PageMeta): string {
  const title = escapeHtml(page.title);
  const desc = escapeHtml(page.description);
  const url = canonicalUrl(page);
  const og = `${SITE_URL}/og.png`;
  const lines = [
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width, initial-scale=1" />`,
    `<title>${title}</title>`,
    `<meta name="description" content="${desc}" />`,
    `<meta name="color-scheme" content="light dark" />`,
    `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fbf8f1" />`,
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#141311" />`,
    page.index ? `<link rel="canonical" href="${url}" />` : `<meta name="robots" content="noindex" />`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />`,
    `<link rel="icon" href="/brand/favicon-32.png" type="image/png" sizes="32x32" />`,
    `<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />`,
    `<link rel="manifest" href="/manifest.webmanifest" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="DaisyChess" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${desc}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${og}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="An ivory chess pawn crowned with a daisy, next to the DaisyChess name" />`,
    `<meta property="og:locale" content="en" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${desc}" />`,
    `<meta name="twitter:image" content="${og}" />`,
  ];
  return lines.join('\n    ');
}

/** The daisy mark, inline (decorative; the link carries the accessible name). */
export const DAISY_SVG = (() => {
  const petals = Array.from({ length: 14 }, (_, i) => {
    const deg = ((360 / 14) * i).toFixed(4);
    return `<ellipse cx="32" cy="14.5" rx="5.4" ry="12" transform="rotate(${deg} 32 32)"/>`;
  }).join('');
  return (
    `<svg class="daisy-mark" viewBox="0 0 64 64" width="32" height="32" aria-hidden="true" focusable="false">` +
    `<g fill="#fff" stroke="#B8C0CA" stroke-width="1.1">${petals}</g>` +
    `<circle cx="32" cy="32" r="9.5" fill="#F5C518" stroke="#D9A000" stroke-width="1.6"/>` +
    `<g fill="#B88A00" opacity=".55"><circle cx="32" cy="28.3" r="2.3"/><path d="M29.6 31.6h4.8l1 4.4h-6.8z"/><rect x="28.2" y="36" width="7.6" height="1.5" rx=".6"/></g>` +
    `</svg>`
  );
})();

export const NAV: readonly { key: string; href: string; label: string }[] = [
  { key: 'features', href: '/features/', label: 'Features' },
  { key: 'nodes', href: '/nodes/', label: 'Community nodes' },
  { key: 'open-source', href: '/open-source/', label: 'Open source' },
  { key: 'support', href: '/support/', label: 'Support' },
];

export function renderHeader(activeKey: string): string {
  const items = NAV.map((n) => {
    const current = n.key === activeKey ? ' aria-current="page"' : '';
    return `<li><a href="${n.href}"${current}>${n.label}</a></li>`;
  }).join('');
  return `<a class="skip-link" href="#main">Skip to content</a>
    <header class="site-header">
      <div class="container header-inner">
        <a class="brand" href="/"${activeKey === 'home' ? ' aria-current="page"' : ''}>${DAISY_SVG}<span>DaisyChess</span></a>
        <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" hidden>
          <span class="nav-toggle-bars" aria-hidden="true"></span><span class="nav-toggle-label">Menu</span>
        </button>
        <nav id="site-nav" class="site-nav" aria-label="Main">
          <ul>${items}</ul>
          <a class="btn btn-primary btn-sm nav-cta" href="${APP_URL}">Play now</a>
        </nav>
      </div>
    </header>`;
}

export function renderFooter(): string {
  const col = (title: string, links: [string, string][]) =>
    `<div class="footer-col"><h2 class="footer-title">${title}</h2><ul>${links
      .map(([href, label]) => `<li><a href="${href}">${label}</a></li>`)
      .join('')}</ul></div>`;
  return `<footer class="site-footer">
      <div class="container footer-inner">
        <div class="footer-brand">
          <a class="brand" href="/">${DAISY_SVG}<span>DaisyChess</span></a>
          <p class="footer-note">Free and open-source chess. No ads, no tracking, no cookies on this site.</p>
        </div>
        <nav class="footer-nav" aria-label="Footer">
          ${col('Product', [
            [APP_URL, 'Play now'],
            ['/features/', 'Features'],
            ['/nodes/', 'Community nodes'],
            [PORTAL_URL, 'Operator portal'],
          ])}
          ${col('Project', [
            ['/open-source/', 'Open source'],
            [REPO_URL, 'Source code'],
            ['/open-source/#third-party', 'Third-party notices'],
            ['/support/', 'Support &amp; FAQ'],
          ])}
          ${col('Legal', [
            ['/privacy/', 'Privacy policy'],
            ['/terms/', 'Terms of use'],
            ['/imprint/', 'Imprint'],
            ['/app-privacy/', 'App privacy'],
            ['/delete-data/', 'Delete your data'],
            ['/accessibility/', 'Accessibility'],
          ])}
        </nav>
      </div>
      <div class="container footer-bottom">
        <p>© ${TOKENS.YEAR} DaisyChess contributors · Licensed under the <a href="/open-source/">GPL-3.0-or-later</a></p>
      </div>
    </footer>`;
}

/**
 * Applies the partial directives of one page:
 * `<!--#head-->`, `<!--#header-->`, `<!--#footer-->`, `<!--#daisy-->` (the mark) and `{{TOKENS}}`.
 */
export function applyPartials(html: string, page: PageMeta): string {
  const out = html
    .replace('<!--#head-->', renderHead(page))
    .replace('<!--#header-->', renderHeader(page.key))
    .replace('<!--#footer-->', renderFooter())
    .replaceAll('<!--#daisy-->', DAISY_SVG);
  return replaceTokens(out);
}

export function buildSitemap(pages: readonly PageMeta[] = PAGES, lastmod?: string): string {
  const urls = pages
    .filter((p) => p.sitemap)
    .map((p) => {
      const lm = lastmod ? `<lastmod>${lastmod}</lastmod>` : '';
      return `  <url><loc>${canonicalUrl(p)}</loc>${lm}</url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
