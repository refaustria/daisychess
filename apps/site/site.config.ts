// Single source of truth for the public site daisychess.org: URLs, page list and metadata.
// Imported by vite.config.ts (HTML partials, sitemap) and by the tests.

/** Canonical origin of this site (no trailing slash). */
export const SITE_URL = 'https://daisychess.org';
/** The web app. */
export const APP_URL = 'https://play.daisychess.org';
/** Operator portal of the hub (community nodes). */
export const PORTAL_URL = 'https://play.daisychess.org/portal/';
/** Link endpoint that community nodes connect to. */
export const HUB_LINK_URL = 'wss://hub.daisychess.org/link';
/** Google Play listing of the Android app (plain URL, no tracking parameters). */
export const androidAppUrl: string | null = 'https://play.google.com/store/apps/details?id=org.daisychess.app';
/** App Store listing of the iOS app. Set it once the app is live: the "coming soon" note then turns into a link. */
export const iosAppUrl: string | null = null;
/** Public contact address (support, privacy requests, imprint). */
export const CONTACT_EMAIL = 'hello@daisychess.org';
/** Source repository. The repo rename is pending: change it here only. */
export const REPO_URL = 'https://github.com/refaustria/daisychess';

export interface PageMeta {
  /** Key used for the active nav item and data-page. */
  key: string;
  /** Source HTML file relative to apps/site. */
  file: string;
  /** Public path (directory style, trailing slash) or file path for the 404 page. */
  path: string;
  title: string;
  description: string;
  /** Listed in sitemap.xml. */
  sitemap: boolean;
  /** Search engines may index it. */
  index: boolean;
}

const DEFAULT_DESCRIPTION =
  'DaisyChess is a free, open-source chess app: analyse with Stockfish in your browser, review your games, train openings and play humans or human-like Maia bots. No ads, no tracking.';

export const PAGES: readonly PageMeta[] = [
  {
    key: 'home',
    file: 'index.html',
    path: '/',
    title: 'DaisyChess — free, open-source chess analysis',
    description: DEFAULT_DESCRIPTION,
    sitemap: true,
    index: true,
  },
  {
    key: 'features',
    file: 'features/index.html',
    path: '/features/',
    title: 'Features — DaisyChess',
    description:
      'Everything DaisyChess does: live Stockfish analysis, automatic game review, an openings trainer with spaced repetition, play vs Maia and friends, game import and the opening explorer.',
    sitemap: true,
    index: true,
  },
  {
    key: 'nodes',
    file: 'nodes/index.html',
    path: '/nodes/',
    title: 'Community nodes — DaisyChess',
    description:
      'Lend the engines of your machine to DaisyChess players: run a private or pool community node with one Docker command. No open port, no domain needed.',
    sitemap: true,
    index: true,
  },
  {
    key: 'open-source',
    file: 'open-source/index.html',
    path: '/open-source/',
    title: 'Open source — DaisyChess',
    description:
      'DaisyChess is free software under the GPL-3.0-or-later. Read the code, run your own server, contribute, and see the third-party components it builds on.',
    sitemap: true,
    index: true,
  },
  {
    key: 'support',
    file: 'support/index.html',
    path: '/support/',
    title: 'Support and FAQ — DaisyChess',
    description: 'Help for DaisyChess: frequently asked questions, how to delete your data, and how to reach us.',
    sitemap: true,
    index: true,
  },
  {
    key: 'privacy',
    file: 'privacy/index.html',
    path: '/privacy/',
    title: 'Privacy policy — DaisyChess',
    description: 'What data DaisyChess handles, for players, node operators and visitors of this website. No ads, no tracking.',
    sitemap: true,
    index: true,
  },
  {
    key: 'app-privacy',
    file: 'app-privacy/index.html',
    path: '/app-privacy/',
    title: 'App privacy summary — DaisyChess',
    description: 'The privacy details of the DaisyChess apps in the form the App Store and Google Play ask for.',
    sitemap: true,
    index: true,
  },
  {
    key: 'delete-data',
    file: 'delete-data/index.html',
    path: '/delete-data/',
    title: 'Delete your data — DaisyChess',
    description: 'How to delete everything DaisyChess keeps about you: on your device, on the server and in the operator portal.',
    sitemap: true,
    index: true,
  },
  {
    key: 'terms',
    file: 'terms/index.html',
    path: '/terms/',
    title: 'Terms of use — DaisyChess',
    description: 'Terms of use of the DaisyChess service for players and community node operators.',
    sitemap: true,
    index: true,
  },
  {
    key: 'imprint',
    file: 'imprint/index.html',
    path: '/imprint/',
    title: 'Imprint — DaisyChess',
    description: 'Provider information for daisychess.org (Impressum and Offenlegung under Austrian law).',
    sitemap: true,
    index: true,
  },
  {
    key: 'accessibility',
    file: 'accessibility/index.html',
    path: '/accessibility/',
    title: 'Accessibility — DaisyChess',
    description: 'How accessible DaisyChess and this website are, known limitations, and how to report a barrier.',
    sitemap: true,
    index: true,
  },
  {
    key: '404',
    file: '404.html',
    path: '/404.html',
    title: 'Page not found — DaisyChess',
    description: 'This page does not exist. Find your way back to DaisyChess, the free and open-source chess app.',
    sitemap: false,
    index: false,
  },
];

export function pageByFile(file: string): PageMeta | undefined {
  const norm = file.replace(/\\/g, '/').replace(/^\/+/, '');
  return PAGES.find((p) => p.file === norm);
}

export function canonicalUrl(page: PageMeta): string {
  return SITE_URL + page.path;
}
