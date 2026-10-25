/**
 * Origin policy for WebSocket upgrades (ADR-008). Browsers attach the page's `Origin` to every
 * WebSocket handshake and ignore CORS for it, so without this check any website could open a
 * socket to the engine server from a visitor's browser (cross-site WebSocket hijacking) and use
 * the visitor's IP quota. The policy is pure so it can be unit-tested.
 */

/** `'*'` disables the check; `null` means "same host as the request" (the default). */
export type OriginPolicy = readonly string[] | '*' | null;

/**
 * Parses `ALLOWED_ORIGINS`: a comma-separated list of origins (`https://play.daisychess.org`), or `*`.
 * Entries are normalised to `scheme://host[:port]` in lower case; anything that is not an
 * absolute http(s) origin throws, so a typo cannot silently disable the check.
 */
export function parseAllowedOrigins(value: string | undefined): OriginPolicy {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed === '*') return '*';
  return trimmed.split(',').map((entry) => {
    const origin = normalizeOrigin(entry.trim());
    if (!origin) throw new Error(`ALLOWED_ORIGINS: "${entry.trim()}" is not an http(s) origin`);
    return origin;
  });
}

/** `scheme://host[:port]` in lower case, or null when `value` is not an absolute http(s) URL. */
export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.origin.toLowerCase();
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Decides whether an upgrade request with the given `Origin` and `Host` headers may proceed.
 *
 * - No `Origin` header: allowed. Only browsers send it; a non-browser client can forge any value,
 *   so rejecting its absence would break tooling (`deploy/ws-smoke.mjs`) without adding security.
 * - Policy `'*'`: allowed.
 * - Explicit list: the normalised origin must be in it.
 * - Default: the origin's host name must equal the request's host name (ports ignored, because
 *   the reverse proxy forwards `Host` without the port while the browser's origin may carry one),
 *   or both must be loopback (the Vite dev server on one port talking to the server on another).
 */
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  policy: OriginPolicy,
): boolean {
  if (origin === undefined) return true;
  if (policy === '*') return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (policy !== null) return policy.includes(normalized);
  const originHost = hostnameOf(normalized);
  const requestHost = host === undefined ? null : hostnameOf(`http://${host}`);
  if (!originHost || !requestHost) return false;
  if (originHost === requestHost) return true;
  return LOOPBACK.has(originHost) && LOOPBACK.has(requestHost);
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
