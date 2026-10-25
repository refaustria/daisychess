// Content-Security-Policy for the operator portal (/portal/). Single source of truth: vite.config.ts
// sends it from `vite preview`, and `node scripts/check-csp.mjs` verifies that the nginx config
// carries exactly PORTAL_CSP. Stricter than the app: no inline script (the portal has no theme
// bootstrap; ui-theme follows prefers-color-scheme), no workers, no WebAssembly. The only
// foreign origin is lichess.org (OAuth token exchange and token revocation).

/** `extraConnect` appends connect-src sources (used for e2e only). */
export function buildPortalCsp(extraConnect = []) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    ["connect-src 'self' https://lichess.org", ...extraConnect].join(' '),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const PORTAL_CSP = buildPortalCsp();
