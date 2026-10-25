/**
 * Portal authentication primitives (ADR-020 §5 "Portal", M24-9): the `__Host-` session cookie,
 * hashed session ids, the CSRF rule for state-changing requests and per-key rate limits.
 *
 * - Session id: 256 random bits, base64url; the store keeps only `sha256(id)` (portal_sessions),
 *   so a leaked database cannot be replayed as cookies. Absolute lifetime 30 days.
 * - Cookie `__Host-dc_portal`: `Secure; HttpOnly; SameSite=Strict; Path=/`, no `Domain` (the
 *   `__Host-` prefix makes browsers enforce exactly that).
 * - CSRF: every state-changing request needs `X-Requested-With: daisychess-portal` (a cross-site
 *   form or a simple request cannot send it; a cross-origin `fetch` with it needs a CORS
 *   preflight the hub never answers) **and** a same-origin `Origin` header.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { OriginPolicy } from '../../ws/origin.js';
import { isOriginAllowed, normalizeOrigin } from '../../ws/origin.js';
import type { RateLimit } from '../../sessions/rateLimit.js';

export const PORTAL_COOKIE = '__Host-dc_portal';
export const PORTAL_SESSION_TTL_MS = 30 * 86_400_000;
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'daisychess-portal';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A fresh session id: 32 random bytes, base64url (43 characters). */
export function newSessionId(random: (size: number) => Uint8Array = randomBytes): string {
  return Buffer.from(random(32)).toString('base64url');
}

/** `sha256(id)` hex: the at-rest form of a session id. */
export function hashSessionId(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

/** The session id carried in a `Cookie` header, if it has the right shape. */
export function sessionIdFromCookies(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== PORTAL_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return SESSION_ID_PATTERN.test(value) ? value : null;
  }
  return null;
}

/** `Set-Cookie` value for a new session (`maxAgeMs` > 0) or one that clears it (0). */
export function sessionCookie(id: string, maxAgeMs: number): string {
  const maxAge = Math.max(0, Math.floor(maxAgeMs / 1000));
  return `${PORTAL_COOKIE}=${maxAge > 0 ? id : ''}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

/**
 * Same-origin check for state-changing portal requests. The `Origin` header is required. It
 * must be `PUBLIC_ORIGIN` or an entry of an explicit `ALLOWED_ORIGINS` list; with neither
 * configured it must name the request's own host (loopback ↔ loopback allowed for development).
 * `ALLOWED_ORIGINS=*` does not open the portal to every site.
 */
export function portalOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  publicOrigin: string | null,
  allowedOrigins: OriginPolicy,
): boolean {
  if (origin === undefined) return false;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const allowed = new Set<string>();
  if (publicOrigin) allowed.add(publicOrigin);
  if (Array.isArray(allowedOrigins)) for (const o of allowedOrigins) allowed.add(o);
  if (allowed.size > 0) return allowed.has(normalized);
  return isOriginAllowed(normalized, host, null);
}

/**
 * Fixed-window counters per key (IP address, session). In memory, bounded by `maxKeys` (expired
 * windows are dropped first, then the oldest keys). Nothing is persisted.
 */
export class WindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: RateLimit,
    private readonly maxKeys = 20_000,
  ) {}

  /** Counts one request of `key`; false when it is over the limit (retry after {@link retryAfterMs}). */
  allow(key: string, now: number): boolean {
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.limit.windowMs) {
      this.windows.delete(key);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      this.evict(now);
    }
    w.count++;
    return w.count <= this.limit.max;
  }

  /** Milliseconds until `key`'s window resets (0 when it has none). */
  retryAfterMs(key: string, now: number): number {
    const w = this.windows.get(key);
    return w ? Math.max(0, this.limit.windowMs - (now - w.start)) : 0;
  }

  get size(): number {
    return this.windows.size;
  }

  private evict(now: number): void {
    if (this.windows.size <= this.maxKeys) return;
    for (const [key, w] of this.windows) {
      if (this.windows.size <= this.maxKeys) break;
      if (now - w.start >= this.limit.windowMs || this.windows.size > this.maxKeys) {
        this.windows.delete(key);
      }
    }
  }
}
