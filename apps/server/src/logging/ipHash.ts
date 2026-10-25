import { createHash, randomBytes } from 'node:crypto';
import { resolveClientIp, type TrustedProxies } from '../ws/clientIp.js';

/**
 * Privacy-preserving client addresses for logs (ADR-020 "logging without PII", closes M10-2).
 *
 * `ipHash = base64url(sha256(dailySalt + ip)).slice(0, 12)`. The salt is random, lives only in
 * memory, rotates with the UTC day and is never persisted or logged, so hashes correlate lines
 * of the same address within one day but cannot be reversed or linked across days (or restarts).
 * Raw addresses may only be logged at `debug` level.
 */
export interface IpHasherOptions {
  /** Epoch ms; tests pass a fake clock. */
  now?: () => number;
  /** Salt source; tests may make it deterministic. */
  randomSalt?: () => string;
}

const DAY_MS = 86_400_000;

export class IpHasher {
  private readonly now: () => number;
  private readonly randomSalt: () => string;
  private day = Number.NaN;
  private salt = '';

  constructor(opts: IpHasherOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.randomSalt = opts.randomSalt ?? (() => randomBytes(32).toString('base64url'));
  }

  hash(ip: string): string {
    const day = Math.floor(this.now() / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.salt = this.randomSalt();
    }
    return createHash('sha256')
      .update(this.salt + ip)
      .digest('base64url')
      .slice(0, 12);
  }
}

/** Process-wide hasher for log lines (one salt per process and UTC day). */
let shared = new IpHasher();

/** Hash of `ip` for logging at `info`/`warn`/`error`. */
export function ipHash(ip: string): string {
  return shared.hash(ip);
}

/** Tests only: replace the process-wide hasher. Returns the previous one. */
export function setSharedIpHasher(h: IpHasher): IpHasher {
  const prev = shared;
  shared = h;
  return prev;
}

/**
 * The log serializer for Fastify's `req`: the client address (X-Real-IP from a trusted proxy,
 * else the socket peer) only as `ipHash`, and no query string (tokens, OAuth codes).
 */
export function requestSerializer(trustedProxies: TrustedProxies) {
  return (req: {
    method?: string;
    url?: string;
    ip?: string;
    raw?: { socket?: { remoteAddress?: string } };
    headers?: Record<string, string | string[] | undefined>;
  }): { method?: string; url?: string; ipHash?: string } => {
    const url = req.url?.split('?')[0];
    const peer = req.raw?.socket?.remoteAddress ?? req.ip;
    const ip =
      peer === undefined
        ? undefined
        : resolveClientIp(peer, req.headers?.['x-real-ip'], trustedProxies);
    return {
      ...(req.method === undefined ? {} : { method: req.method }),
      ...(url === undefined ? {} : { url }),
      ...(ip === undefined ? {} : { ipHash: ipHash(ip) }),
    };
  };
}
