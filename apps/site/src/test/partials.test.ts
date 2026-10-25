import { describe, expect, it } from 'vitest';
import { applyPartials, buildSitemap, escapeHtml, renderFooter, renderHead, renderHeader, replaceTokens } from '../../build/partials';
import { APP_URL, PAGES, REPO_URL, SITE_URL, canonicalUrl, pageByFile } from '../../site.config';

const home = pageByFile('index.html')!;
const notFound = pageByFile('404.html')!;

describe('site.config', () => {
  it('has unique keys, files and paths, and directory-style paths', () => {
    expect(new Set(PAGES.map((p) => p.key)).size).toBe(PAGES.length);
    expect(new Set(PAGES.map((p) => p.file)).size).toBe(PAGES.length);
    expect(new Set(PAGES.map((p) => p.path)).size).toBe(PAGES.length);
    for (const p of PAGES) {
      if (p.key !== '404') expect(p.path.endsWith('/')).toBe(true);
      expect(p.description.length).toBeGreaterThan(40);
      expect(p.description.length).toBeLessThan(200);
    }
  });

  it('builds canonical URLs on the apex domain', () => {
    expect(canonicalUrl(home)).toBe('https://daisychess.org/');
    expect(canonicalUrl(pageByFile('features/index.html')!)).toBe('https://daisychess.org/features/');
  });

  it('finds pages by file, also with Windows separators', () => {
    expect(pageByFile('privacy\\index.html')?.key).toBe('privacy');
    expect(pageByFile('/terms/index.html')?.key).toBe('terms');
    expect(pageByFile('nope.html')).toBeUndefined();
  });
});

describe('partials', () => {
  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('replaces known tokens and rejects unknown ones', () => {
    expect(replaceTokens('{{APP_URL}}/x {{REPO_URL}}')).toBe(`${APP_URL}/x ${REPO_URL}`);
    expect(replaceTokens('mailto:{{CONTACT_EMAIL}}')).toBe('mailto:hello@daisychess.org');
    expect(() => replaceTokens('{{NOPE}}')).toThrow(/unknown template token/);
  });

  it('renders head metadata with canonical, OG and Twitter tags', () => {
    const head = renderHead(home);
    expect(head).toContain(`<link rel="canonical" href="${SITE_URL}/" />`);
    expect(head).toContain(`<meta property="og:image" content="${SITE_URL}/og.png" />`);
    expect(head).toContain('twitter:card" content="summary_large_image"');
    expect(head).toContain('<title>DaisyChess — free, open-source chess analysis</title>');
    expect(head).not.toContain('noindex');
  });

  it('marks the 404 page noindex without a canonical link', () => {
    const head = renderHead(notFound);
    expect(head).toContain('<meta name="robots" content="noindex" />');
    expect(head).not.toContain('rel="canonical"');
  });

  it('marks exactly the active nav item', () => {
    const h = renderHeader('features');
    expect(h.match(/aria-current="page"/g)).toHaveLength(1);
    expect(h).toContain('<a href="/features/" aria-current="page">Features</a>');
    expect(renderHeader('home')).toContain('class="brand" href="/" aria-current="page"');
    expect(renderHeader('privacy')).not.toContain('aria-current');
  });

  it('links every legal page from the footer', () => {
    const f = renderFooter();
    for (const path of ['/privacy/', '/terms/', '/imprint/', '/app-privacy/', '/delete-data/', '/accessibility/', '/support/']) {
      expect(f).toContain(`href="${path}"`);
    }
  });

  it('applies all directives of a page', () => {
    const html = applyPartials(
      '<head><!--#head--></head><body><!--#header--><a href="{{APP_URL}}">x</a><!--#daisy--><!--#daisy--><!--#footer--></body>',
      home,
    );
    expect(html).not.toMatch(/<!--#|\{\{/);
    expect(html.match(/class="daisy-mark"/g)!.length).toBe(4); // header, 2 inline, footer
    expect(html).toContain(`href="${APP_URL}"`);
  });
});

describe('buildSitemap', () => {
  it('lists every indexable page once and leaves out the 404 page', () => {
    const xml = buildSitemap(PAGES, '2026-10-25');
    for (const p of PAGES.filter((x) => x.sitemap)) expect(xml).toContain(`<loc>${canonicalUrl(p)}</loc>`);
    expect(xml).not.toContain('404');
    expect(xml).toContain('<lastmod>2026-10-25</lastmod>');
    expect(xml.startsWith('<?xml')).toBe(true);
  });

  it('omits lastmod when no date is given', () => {
    expect(buildSitemap(PAGES)).not.toContain('lastmod');
  });
});
