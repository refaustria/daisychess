import type { EngineDescriptor, HelloMessage, Limits } from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import type { AnalysisBackend } from '../sessions/AnalysisBackend.js';
import type {
  AnalysisRoute,
  AnalysisRouter,
  RoutePeer,
  RouteResult,
} from '../sessions/AnalysisRouter.js';
import { ClientSessions, type SessionLedger } from '../sessions/ClientSessions.js';
import type { RateLimit } from '../sessions/rateLimit.js';
import { tokenMatches } from './token.js';

export interface LocalRouterOptions {
  /** Where sessions lease their engines (`LocalBackend` over the pool). */
  backend: AnalysisBackend;
  limits: Limits;
  /** Engines as announced in `welcome` (disabled ones are rejected with `unknown_engine`). */
  engines: readonly EngineDescriptor[];
  logger: PoolLogger;
  /** Per-address session cap, lease-based (`IpSessionLedger`), shared by every connection. */
  ledger: SessionLedger;
  /** A session without a running search releases its lease after this long. */
  sessionIdleMs: number;
  stopTimeoutMs?: number;
  analyzeRateLimit?: RateLimit;
  /**
   * When set (non-empty), a `hello` whose `token` does not equal it is denied (ADR-010/013):
   * restricted welcome with `analysisDenied: 'no_token' | 'bad_token'`.
   */
  accessToken?: string | null;
}

/**
 * The standalone router (ADR-020 relay layering §2): today's semantics — an open server, or the
 * shared `ACCESS_TOKEN` (constant-time) — and every connection's channel is a
 * {@link ClientSessions} over this server's engines with the lease-based per-IP ledger.
 */
export class LocalRouter implements AnalysisRouter {
  private readonly route_: AnalysisRoute;

  constructor(private readonly opts: LocalRouterOptions) {
    const { backend, limits, engines, logger, ledger, sessionIdleMs } = opts;
    this.route_ = {
      limits,
      engines,
      open: (deliver, peer) =>
        new ClientSessions(deliver, peer, {
          backend,
          limits,
          engines,
          logger,
          ledger,
          sessionIdleMs,
          ...(opts.stopTimeoutMs !== undefined ? { stopTimeoutMs: opts.stopTimeoutMs } : {}),
          ...(opts.analyzeRateLimit ? { analyzeRateLimit: opts.analyzeRateLimit } : {}),
        }),
    };
  }

  get restrictedLimits(): Limits {
    return this.opts.limits;
  }

  route(hello: HelloMessage, peer: RoutePeer): RouteResult {
    const required = this.opts.accessToken;
    if (required && !tokenMatches(hello.token, required)) {
      // Never log the token itself, only whether one was sent.
      this.opts.logger.info(
        { conn: peer.connId, tokenSent: hello.token !== undefined },
        'handshake without a valid access token: restricted to rooms',
      );
      return { ok: false, reason: hello.token === undefined ? 'no_token' : 'bad_token' };
    }
    return { ok: true, route: this.route_ };
  }
}
