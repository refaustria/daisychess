# @daisychess/site — daisychess.org

The public community website: a static Vite multi-page site (vanilla TypeScript, no framework).
Every page is real HTML in `dist/` (SEO, works without JavaScript); JavaScript only adds the mobile
menu, smooth scrolling, reveals and the 3D pawn.

```bash
pnpm --filter @daisychess/site dev          # http://localhost:5182
pnpm --filter @daisychess/site build        # -> apps/site/dist
pnpm --filter @daisychess/site test         # Vitest (profile, partials, nav, env)
pnpm --filter @daisychess/site e2e          # Playwright against `vite preview` with the production CSP (port 4192)
pnpm --filter @daisychess/site render-assets  # re-render public/img/pawn-hero.{png,webp} and public/og.png
```

- **Pages** are `index.html`, `<name>/index.html` and `404.html`; metadata (title, description,
  canonical path) lives in `site.config.ts` together with the URLs (`APP_URL`, `PORTAL_URL`,
  `HUB_LINK_URL`, `REPO_URL`). `build/partials.ts` replaces `<!--#head-->`, `<!--#header-->`,
  `<!--#footer-->`, `<!--#daisy-->` and `{{TOKENS}}` at build time and emits `sitemap.xml`.
  A new page = an HTML file + an entry in `PAGES`.
- **Scripts:** `src/scripts/page.ts` (text pages: nav only), `features.ts` (features/nodes: + Lenis
  and gsap reveals), `home.ts` (+ the three.js hero). Motion code and three.js are dynamic imports,
  loaded only without `prefers-reduced-motion` and, for three.js, only with WebGL. The hero renders
  through gsap's ticker only while it is on screen and the tab is visible; DPR is capped at 2.
  Fallback image (reduced motion, no WebGL, no JS): `public/img/pawn-hero.*`, rendered from the
  same scene by `tools/render-assets.mjs`.
- **Security:** `csp.config.mjs` is the single source of the CSP and headers; `vite preview` sends
  them and `node scripts/check-site-csp.mjs` checks `deploy/nginx/daisychess.org.conf`.
  No inline scripts or styles, nothing loaded from other origins (font self-hosted).
- **Deploy:** `deploy/deploy-site.sh` (build + rsync to `/var/www/daisychess.org`).
- **Store registration:** `STORE_CHECKLIST.md` (not published).
