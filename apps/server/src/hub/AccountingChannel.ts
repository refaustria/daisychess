import {
  checkAnalyzeLimits,
  type AnalyzeMessage,
  type ErrorMessage,
  type Limits,
  type ProtocolErrorCode,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import type { AnalysisChannel } from '../sessions/AnalysisChannel.js';
import type {
  AnalysisClientMessage,
  AnalysisServerMessage,
  Deliver,
  SessionLedger,
} from '../sessions/ClientSessions.js';
import { allowRate, type RateLimit } from '../sessions/rateLimit.js';
import { SessionTracker } from '../sessions/SessionTracker.js';

/** Engine time left today for a token on a pool route (ms); null = no budget applies. */
export interface BudgetSource {
  remainingMs(tokenId: string, now: number): number | null;
}

/** Where metered usage goes (`HubTokenService.addEngineTime` / `recordSession`). */
export interface UsageSink {
  /** One search ended at `at` after `engineMs` (capped) of engine time. */
  search(u: { tokenId: string; nodeId: string; engineMs: number; at: number }): void;
  /** One session opened (first `analyze` of a session id) at `at`. */
  session(u: { tokenId: string; nodeId: string; at: number }): void;
}

/** Per-key session slots with a cap per key (tokens: the tier's `sessions`). */
export class TokenSessionLedger {
  private readonly counts = new Map<string, number>();

  /** A {@link SessionLedger} view with `cap` slots per token. */
  forCap(cap: number): SessionLedger {
    return {
      maxPerIp: cap,
      tryReserve: (key) => this.tryReserve(key, cap),
      release: (key) => this.release(key),
    };
  }

  tryReserve(key: string, cap: number): boolean {
    const n = this.counts.get(key) ?? 0;
    if (n >= cap) return false;
    this.counts.set(key, n + 1);
    return true;
  }

  release(key: string): void {
    const n = this.counts.get(key);
    if (n === undefined) return;
    if (n <= 1) this.counts.delete(key);
    else this.counts.set(key, n - 1);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** Tokens currently holding at least one slot. */
  get tokens(): number {
    return this.counts.size;
  }
}

export interface AccountingChannelOptions {
  /** The route's composed limits (`welcome.limits`). */
  limits: Limits;
  /** A session without an open search frees its slots after this long (mirrors the node). */
  sessionIdleMs: number;
  logger: PoolLogger;
  slots: { ip: SessionLedger; token?: SessionLedger };
  keys: { ip: string; tokenId: string; nodeId: string; connId: number | string };
  /** Routed through the pool: the daily budget applies. */
  shared: boolean;
  budget?: BudgetSource;
  usage: UsageSink;
  /**
   * `welcome.engines` defaults (clamped to the route's limits) by engine id: an `analyze` without
   * `threads`/`hash` gets them filled in, so a tier's thread cap also binds clients that rely on
   * the defaults (the node would otherwise apply its own, unclamped ones).
   */
  engineDefaults?: ReadonlyMap<string, { threads: number; hash: number }>;
  /** `analyze` per window, checked before anything is relayed. Default 20 per second. */
  analyzeRateLimit?: RateLimit;
  /** A session opened (+1) or closed (−1) — the router's pool load. */
  onSessionDelta?: (delta: 1 | -1) => void;
  /** A search on this route ended with `engine_crashed` (the scheduler's failure penalty). */
  onEngineFailure?: () => void;
  now?: () => number;
}

interface SessionAcct {
  ip: boolean;
  token: boolean;
  /** A search of this session completed with `bestmove` at least once. */
  served: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** Errors that end a search before an engine worked on it: a fresh session gives its slots back. */
const REFUSALS: ReadonlySet<ProtocolErrorCode> = new Set<ProtocolErrorCode>([
  'no_capacity',
  'unknown_engine',
  'limit_exceeded',
  'rate_limited',
  'forbidden',
  'invalid_message',
  'unauthorized',
]);

/** Slack on top of `maxMovetimeMs` a search may be metered for (the server's wall-clock cap). */
const METER_SLACK_MS = 2_000;

/**
 * The hub's accounting decorator around every routed channel, remote relay or `local`
 * (ADR-020 relay layering §4). It derives session state from the message stream:
 *
 * - A session opens at its first `analyze`: synchronously one slot in the hub-wide per-IP ledger
 *   (`no_capacity`), one in the per-token ledger (tier cap, `limit_exceeded`) and the
 *   per-connection cap (`limit_exceeded`) — a refused `analyze` never reaches the inner channel.
 * - It closes (slots freed) on `release`, a session-level `error`, `retireAll`, `close`, after
 *   `sessionIdleMs` without an open search, and when the first search of a fresh session was
 *   refused (`no_capacity` from the node etc.), so a refused tab does not pin a slot.
 * - Usage: every terminal (`bestmove`, `error` with `searchId`) meters `min(ended − started,
 *   maxMovetimeMs + 2 s)` through {@link UsageSink}; `close()` meters searches still running.
 * - Budget (pool routes): before each `analyze`, today's remaining budget minus the elapsed time
 *   of this channel's running searches must be positive, else `error no_capacity "daily pool
 *   budget exhausted"`. A search is metered at most `maxMovetimeMs + 2 s`, so the budget is
 *   overrun by at most one search per concurrent session.
 */
export class AccountingChannel implements AnalysisChannel {
  private readonly inner: AnalysisChannel;
  private readonly tracker: SessionTracker;
  private readonly sessions = new Map<string, SessionAcct>();
  private readonly analyzeTimes: number[] = [];
  private readonly analyzeRate: RateLimit;
  private readonly now: () => number;
  private readonly meterCapMs: number;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    createInner: (deliver: Deliver) => AnalysisChannel,
    private readonly deliver: Deliver,
    private readonly opts: AccountingChannelOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.tracker = new SessionTracker(this.now);
    this.analyzeRate = opts.analyzeRateLimit ?? { max: 20, windowMs: 1_000 };
    this.meterCapMs = opts.limits.maxMovetimeMs + METER_SLACK_MS;
    this.inner = createInner((m) => this.onOut(m));
  }

  /** Sessions holding slots on the hub. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Searches still owed a terminal message. */
  get openSearchCount(): number {
    return this.tracker.openSearchCount;
  }

  get lost(): Promise<void> | undefined {
    return this.inner.lost;
  }

  handle(msg: AnalysisClientMessage): void {
    if (this.closed) return;
    switch (msg.type) {
      case 'analyze':
        this.analyze(msg);
        return;
      case 'stop':
        this.inner.handle(msg);
        return;
      case 'release':
        this.closeSession(msg.sessionId);
        this.tracker.in(msg);
        this.inner.handle(msg);
        return;
    }
  }

  retireAll(): void {
    if (this.closed) return;
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
    this.inner.retireAll();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const now = this.now();
    for (const s of this.tracker.openSearchList()) this.meter(now - s.startedAt, now);
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
    this.closePromise = this.inner.close();
    return this.closePromise;
  }

  // -------------------------------------------------------------------------------------------

  private analyze(original: AnalyzeMessage): void {
    const msg = this.withDefaults(original);
    const { sessionId, searchId } = msg;
    const now = this.now();
    if (!allowRate(this.analyzeTimes, this.analyzeRate, now)) {
      this.reject('rate_limited', 'too many analyze requests', sessionId, searchId);
      return;
    }
    const violation = checkAnalyzeLimits(msg, this.opts.limits);
    if (violation) {
      this.reject('limit_exceeded', violation, sessionId, searchId);
      return;
    }
    if (this.opts.shared && this.opts.budget) {
      const remaining = this.opts.budget.remainingMs(this.opts.keys.tokenId, now);
      if (remaining !== null && remaining - this.runningMs(now) <= 0) {
        this.opts.logger.info(
          { conn: this.opts.keys.connId, tokenId: this.opts.keys.tokenId },
          'daily pool budget exhausted',
        );
        this.reject('no_capacity', 'daily pool budget exhausted', sessionId, searchId);
        return;
      }
    }
    let session = this.sessions.get(sessionId);
    if (!session) {
      const opened = this.openSession(sessionId, searchId);
      if (!opened) return;
      session = opened;
    }
    this.clearIdle(session);
    this.tracker.in(msg);
    this.inner.handle(msg);
  }

  private withDefaults(msg: AnalyzeMessage): AnalyzeMessage {
    const d = this.opts.engineDefaults?.get(msg.engine);
    if (!d || (msg.threads !== undefined && msg.hash !== undefined)) return msg;
    return { ...msg, threads: msg.threads ?? d.threads, hash: msg.hash ?? d.hash };
  }

  private openSession(sessionId: string, searchId: number): SessionAcct | null {
    const { limits, slots, keys } = this.opts;
    if (this.sessions.size >= limits.maxSessionsPerConnection) {
      this.reject(
        'limit_exceeded',
        `at most ${limits.maxSessionsPerConnection} sessions per connection`,
        sessionId,
        searchId,
      );
      return null;
    }
    if (!slots.ip.tryReserve(keys.ip)) {
      this.opts.logger.info(
        { conn: keys.connId, session: sessionId },
        'per-address session cap reached',
      );
      this.reject(
        'no_capacity',
        `too many sessions from your address (at most ${slots.ip.maxPerIp})`,
        sessionId,
        searchId,
      );
      return null;
    }
    if (slots.token && !slots.token.tryReserve(keys.tokenId)) {
      slots.ip.release(keys.ip);
      this.reject(
        'limit_exceeded',
        `at most ${slots.token.maxPerIp} sessions per token`,
        sessionId,
        searchId,
      );
      return null;
    }
    const session: SessionAcct = {
      ip: true,
      token: slots.token !== undefined,
      served: false,
      idleTimer: null,
    };
    this.sessions.set(sessionId, session);
    this.notify(() => this.opts.onSessionDelta?.(1));
    this.notify(() =>
      this.opts.usage.session({ tokenId: keys.tokenId, nodeId: keys.nodeId, at: this.now() }),
    );
    return session;
  }

  private closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.clearIdle(session);
    const { slots, keys } = this.opts;
    if (session.ip) slots.ip.release(keys.ip);
    if (session.token) slots.token?.release(keys.tokenId);
    session.ip = session.token = false;
    this.notify(() => this.opts.onSessionDelta?.(-1));
  }

  /** Every message from the inner channel passes here before the player sees it. */
  private onOut(msg: AnalysisServerMessage): void {
    if (this.closed) return;
    if (msg.type !== 'info' && msg.sessionId !== undefined) {
      const events = this.tracker.out(msg);
      const sessionId = msg.sessionId;
      const session = this.sessions.get(sessionId);
      for (const e of events) {
        if (e.kind !== 'search_ended') continue;
        this.meter((e.endedAt ?? this.now()) - e.startedAt, e.endedAt ?? this.now());
        if (msg.type === 'bestmove' && session) session.served = true;
      }
      if (msg.type === 'error' && msg.code === 'engine_crashed') {
        this.notify(() => this.opts.onEngineFailure?.());
      }
      if (msg.type === 'error' && msg.searchId === undefined) {
        this.closeSession(sessionId); // session-level failure
      } else if (session && this.tracker.openSearches(sessionId).length === 0) {
        if (msg.type === 'error' && REFUSALS.has(msg.code) && !session.served) {
          this.closeSession(sessionId);
        } else {
          this.armIdle(sessionId, session);
        }
      }
    }
    try {
      this.deliver(msg);
    } catch (err) {
      this.opts.logger.warn(
        { conn: this.opts.keys.connId, err: (err as Error).message },
        'accounting: deliver failed',
      );
    }
  }

  private armIdle(sessionId: string, session: SessionAcct): void {
    this.clearIdle(session);
    const t = setTimeout(() => {
      session.idleTimer = null;
      if (this.sessions.get(sessionId) !== session) return;
      if (this.tracker.openSearches(sessionId).length > 0) return;
      this.opts.logger.debug(
        { conn: this.opts.keys.connId, session: sessionId },
        'accounting: idle session frees its slots',
      );
      this.closeSession(sessionId);
    }, this.opts.sessionIdleMs);
    t.unref?.();
    session.idleTimer = t;
  }

  private clearIdle(session: SessionAcct): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  /** Elapsed (capped) engine time of the searches still running on this channel. */
  private runningMs(now: number): number {
    let ms = 0;
    for (const s of this.tracker.openSearchList()) {
      ms += Math.min(Math.max(0, now - s.startedAt), this.meterCapMs);
    }
    return ms;
  }

  private meter(elapsedMs: number, at: number): void {
    const engineMs = Math.min(Math.max(0, elapsedMs), this.meterCapMs);
    const { tokenId, nodeId } = this.opts.keys;
    this.notify(() => this.opts.usage.search({ tokenId, nodeId, engineMs, at }));
  }

  /** Callbacks into the hub (store writes, router stats) must never break the relay. */
  private notify(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.opts.logger.warn(
        { conn: this.opts.keys.connId, err: (err as Error).message },
        'accounting: callback failed',
      );
    }
  }

  private reject(
    code: ProtocolErrorCode,
    message: string,
    sessionId: string,
    searchId: number,
  ): void {
    const msg: ErrorMessage = { type: 'error', code, message, sessionId, searchId };
    try {
      this.deliver(msg);
    } catch (err) {
      this.opts.logger.warn(
        { conn: this.opts.keys.connId, err: (err as Error).message },
        'accounting: deliver failed',
      );
    }
  }
}
