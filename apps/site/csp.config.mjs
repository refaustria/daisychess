// Content-Security-Policy and security headers of the public site daisychess.org (apps/site).
// Single source of truth: vite.config.ts sends them from `vite preview` (e2e runs against that), and
// `node scripts/check-site-csp.mjs` verifies that deploy/nginx/daisychess.org.conf carries exactly
// SITE_CSP. three.js, gsap and Lenis need nothing beyond 'self': no eval, no workers, no blob: or
// WebAssembly; inline styles are only set through the CSSOM (element.style), which style-src does
// not restrict. img-src keeps data: for small inlined images Vite may emit.

export const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers nginx adds to every response (besides Cache-Control); mirrored by `vite preview`. */
export const SITE_SECURITY_HEADERS = {
  'Content-Security-Policy': SITE_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
