import { isIP } from 'node:net';

/**
 * Client addresses and the per-IP session cap (docs/SECURITY.md §3, ADR-008 addendum).
 *
 * In production the server only ever sees nginx on loopback, so the real client address comes
 * from `X-Real-IP`. That header is trusted only when the TCP peer is a trusted proxy (loopback,
 * or an address in `TRUSTED_PROXIES`); anyone else could put an arbitrary value in it.
 */

/** `'*'` trusts `X-Real-IP` from every peer; a list adds proxies to the always-trusted loopback. */
export type TrustedProxies = readonly string[] | '*';

/**
 * Canonical form of an IP address: lower case, without an IPv6 zone, IPv4-mapped IPv6
 * (`::ffff:1.2.3.4`) unwrapped to IPv4. Returns null when `value` is not an IP address.
 */
export function normalizeIp(value: string | undefined): string | null {
  if (value === undefined) return null;
  let ip = value.trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) ip = mapped[1]!;
  return isIP(ip) === 0 ? null : ip;
}

export function isLoopback(ip: string): boolean {
  return ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.'));
}

/** Parses `TRUSTED_PROXIES` (comma-separated IP addresses, or `*`); throws on garbage. */
export function parseTrustedProxies(value: string | undefined): TrustedProxies {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return [];
  if (trimmed === '*') return '*';
  return trimmed.split(',').map((entry) => {
    const ip = normalizeIp(entry);
    if (!ip) throw new Error(`TRUSTED_PROXIES: "${entry.trim()}" is not an IP address`);
    return ip;
  });
}

/**
 * The address a connection is accounted to: `X-Real-IP` when the socket peer is a trusted proxy
 * and the header holds a valid address, otherwise the socket peer itself. `'unknown'` when the
 * socket has no address (already closed), so such connections share one bucket.
 */
export function resolveClientIp(
  remoteAddress: string | undefined,
  realIpHeader: string | string[] | undefined,
  trusted: TrustedProxies = [],
): string {
  const peer = normalizeIp(remoteAddress);
  if (!peer) return 'unknown';
  const proxied = isLoopback(peer) || trusted === '*' || trusted.includes(peer);
  if (proxied) {
    const header = Array.isArray(realIpHeader) ? realIpHeader[0] : realIpHeader;
    const real = normalizeIp(header);
    if (real) return real;
  }
  return peer;
}

/**
 * Counts engine sessions (leased or being leased) per client address. Reservation is synchronous,
 * so two connections from the same address racing for the last slot cannot both get it.
 */
export class IpSessionLedger {
  private readonly counts = new Map<string, number>();
  private held = 0;

  constructor(readonly maxPerIp: number) {}

  /** Takes a slot for `ip`; false when the address is at its cap. */
  tryReserve(ip: string): boolean {
    const n = this.counts.get(ip) ?? 0;
    if (n >= this.maxPerIp) return false;
    this.counts.set(ip, n + 1);
    this.held++;
    return true;
  }

  /** Returns a slot taken with {@link tryReserve}. */
  release(ip: string): void {
    const n = this.counts.get(ip);
    if (n === undefined) return;
    this.held--;
    if (n <= 1) this.counts.delete(ip);
    else this.counts.set(ip, n - 1);
  }

  count(ip: string): number {
    return this.counts.get(ip) ?? 0;
  }

  /** Addresses currently holding at least one slot. */
  get addresses(): number {
    return this.counts.size;
  }

  /** Slots held over all addresses. */
  get total(): number {
    return this.held;
  }
}
