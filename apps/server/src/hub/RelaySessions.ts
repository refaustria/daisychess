import {
  HubRelayMessageSchema,
  LINK_DEFAULTS,
  checkAnalyzeLimits,
  type ErrorMessage,
  type HubToNodeMessage,
  type Limits,
  type NodeRelayMessage,
  type ProtocolErrorCode,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import type { AnalysisChannel } from '../sessions/AnalysisChannel.js';
import type { AnalysisClientMessage, Deliver } from '../sessions/ClientSessions.js';
import { SessionTracker } from '../sessions/SessionTracker.js';

/**
 * What a {@link RelaySessions} needs from the hub's link to one node (ADR-020 relay layering §3).
 * `HubNodeLink` provides one per `cid`; tests pass a fake.
 */
export interface LinkPort {
  readonly nodeId: string;
  /** Sends one frame to the node; false when the link is gone (nothing was sent). */
  send(msg: HubToNodeMessage): boolean;
}

export interface RelaySessionsOptions {
  logger: PoolLogger;
  /**
   * The composed limits of this route (`welcome.limits`). When set, an `analyze` above them is
   * answered locally with `limit_exceeded` and never relayed (ADR-020 §3: the node is not
   * bothered with an over-limit request; it checks again against its own limits anyway).
   */
  limits?: Limits;
  /** {@link RelaySessions.close} resolves at the latest after this long. Default 2 s. */
  closeTimeoutMs?: number;
  /**
   * `info` frames per second per search forwarded to the player; above it they are dropped
   * (never terminal messages). The node already caps at `LINK_DEFAULTS.infoPerSecondPerSearch`;
   * the hub's default is twice that so link jitter never drops an honest node's `info`.
   */
  infoPerSecondPerSearch?: number;
  /** Clock (ms). Default `Date.now`. */
  now?: () => number;
  /**
   * Called once when the channel is finished for the link's bookkeeping: `close()` completed
   * (ack, link loss or timeout), the node was lost, or the node refused the client.
   */
  onDone?: () => void;
}

export type RelayState = 'open' | 'closing' | 'closed' | 'lost';

export interface RelayStats {
  state: RelayState;
  sessions: number;
  openSearches: number;
  relayed: number;
  delivered: number;
  dropped: { unknown: number; infoRate: number };
}

interface InfoWindow {
  searchId: number;
  windowStart: number;
  count: number;
}

/** Bound of the "stop for a session the hub does not track" bookkeeping (see `pendingStops`). */
const MAX_PENDING_STOPS = 64;

/**
 * The hub side of one player connection routed to a remote node (ADR-020 relay layering §3): a
 * dumb, validated relay with bookkeeping. `analyze`/`stop`/`release` go to the node as
 * `client.msg {cid, msg}`; the node's `info`/`bestmove`/`error` for this `cid` come back through
 * {@link onNodeMessage} and are delivered unchanged. The node's `ClientSessions` is the state
 * machine (ordering, stopping, timing); this class only guarantees that **every relayed search
 * gets exactly one terminal message**, also when the node goes away:
 *
 * - A {@link SessionTracker} records each relayed `analyze` as an open search and ends it on its
 *   terminal (`bestmove`, or `error` with `searchId`); `release`/`close` close the session but
 *   keep its open searches until their terminal arrives.
 * - Node messages that do not belong to a tracked search or session are dropped (a node can only
 *   speak about what this player asked), `info` is capped per search.
 * - {@link onNodeLost} (link dropped, node replaced/revoked) and an unrequested `client.closed`
 *   (the node refused the client) emit one `error engine_crashed {sessionId, searchId}` per open
 *   search (released ones included) and one `error engine_crashed {sessionId}` per open session
 *   without a search, then the channel is dead: {@link lost} resolves so the hub's `Connection`
 *   closes the player socket with 1012 (M24-6) and the client reconnects to a fresh route.
 */
export class RelaySessions implements AnalysisChannel {
  private st: RelayState = 'open';
  private tracker: SessionTracker;
  private readonly infoWindows = new Map<string, InfoWindow>();
  /**
   * `stop` relayed for a session the tracker does not know: the node answers it with a
   * session-level `session_not_found`, which must reach the player as it would on a standalone
   * server. Counted per sessionId, bounded.
   */
  private readonly pendingStops = new Map<string, number>();
  private closePromise: Promise<void> | null = null;
  private resolveClose: (() => void) | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveLost!: () => void;
  private done = false;
  private readonly now: () => number;
  private readonly infoPerSecond: number;
  private readonly log: PoolLogger;
  private readonly counters = { relayed: 0, delivered: 0, unknown: 0, infoRate: 0 };

  /** Resolves once when the node was lost or refused this client (not on a regular close). */
  readonly lost: Promise<void>;

  constructor(
    private readonly deliver: Deliver,
    private readonly link: LinkPort,
    readonly cid: string,
    private readonly opts: RelaySessionsOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.tracker = new SessionTracker(this.now);
    this.infoPerSecond = opts.infoPerSecondPerSearch ?? LINK_DEFAULTS.infoPerSecondPerSearch * 2;
    this.log = opts.logger;
    this.lost = new Promise((r) => (this.resolveLost = r));
  }

  get state(): RelayState {
    return this.st;
  }

  get nodeId(): string {
    return this.link.nodeId;
  }

  /** Open sessions as derived from the message stream (0 once closed or lost). */
  get sessionCount(): number {
    return this.st === 'open' ? this.tracker.openSessions.length : 0;
  }

  /** Searches still owed a terminal message. */
  get openSearchCount(): number {
    return this.st === 'open' || this.st === 'closing' ? this.tracker.openSearchCount : 0;
  }

  stats(): RelayStats {
    return {
      state: this.st,
      sessions: this.sessionCount,
      openSearches: this.openSearchCount,
      relayed: this.counters.relayed,
      delivered: this.counters.delivered,
      dropped: { unknown: this.counters.unknown, infoRate: this.counters.infoRate },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Player → node

  handle(msg: AnalysisClientMessage): void {
    if (this.st === 'closing' || this.st === 'closed') return;
    if (this.st === 'lost') {
      // The Connection is about to close 1012; an analyze that raced it still gets its terminal.
      if (msg.type === 'analyze') {
        this.emit(
          errorMsg('engine_crashed', 'engine node unavailable', msg.sessionId, msg.searchId),
        );
      }
      return;
    }
    const parsed = HubRelayMessageSchema.safeParse(msg);
    if (!parsed.success) {
      // Connection validated it already; this is a programming error, but keep the guarantee.
      this.log.warn({ cid: this.cid, type: msg.type }, 'relay: invalid client message dropped');
      if (msg.type === 'analyze') {
        this.emit(errorMsg('invalid_message', 'invalid analyze', msg.sessionId, msg.searchId));
      }
      return;
    }
    const m = parsed.data;
    if (m.type === 'analyze' && this.opts.limits) {
      const violation = checkAnalyzeLimits(m, this.opts.limits);
      if (violation) {
        this.emit(errorMsg('limit_exceeded', violation, m.sessionId, m.searchId));
        return;
      }
    }
    if (m.type === 'stop' && !this.tracker.openSessions.includes(m.sessionId)) {
      this.notePendingStop(m.sessionId);
    }
    // Tracked before sending: a node loss detected by the send itself must see this search.
    this.tracker.in(m);
    if (m.type === 'release') this.infoWindows.delete(m.sessionId);
    if (!this.link.send({ type: 'client.msg', cid: this.cid, msg: m })) {
      this.onNodeLost();
      return;
    }
    this.counters.relayed++;
  }

  /** Fair play (ADR-013): relays a `release` for every open session. */
  retireAll(): void {
    if (this.st !== 'open') return;
    for (const sessionId of this.tracker.openSessions) {
      this.handle({ type: 'release', sessionId });
      if (this.st !== 'open') return;
    }
  }

  /**
   * Sends `client.close {cid}` and resolves on the node's `client.closed`, on link loss or after
   * `closeTimeoutMs` (2 s). Idempotent; nothing is delivered once called.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.st === 'lost' || this.st === 'closed') {
      this.st = 'closed';
      this.closePromise = Promise.resolve();
      this.finish();
      return this.closePromise;
    }
    this.st = 'closing';
    this.closePromise = new Promise<void>((r) => (this.resolveClose = r));
    if (!this.link.send({ type: 'client.close', cid: this.cid })) {
      this.completeClose();
      return this.closePromise;
    }
    const t = setTimeout(() => {
      this.closeTimer = null;
      if (this.st !== 'closing') return;
      this.log.debug({ cid: this.cid, node: this.link.nodeId }, 'relay: no client.closed in time');
      this.completeClose();
    }, this.opts.closeTimeoutMs ?? 2_000);
    t.unref?.();
    this.closeTimer = t;
    return this.closePromise;
  }

  // -------------------------------------------------------------------------------------------
  // Node → player (called by HubNodeLink with frames already validated by link.ts)

  onNodeMessage(msg: NodeRelayMessage): void {
    if (this.st !== 'open') return;
    if (msg.type === 'info') {
      if (!this.tracker.openSearches(msg.sessionId).includes(msg.searchId)) {
        this.dropUnknown(msg);
        return;
      }
      if (!this.allowInfo(msg.sessionId, msg.searchId, msg.info.policy !== undefined)) return;
      this.emit(msg);
      return;
    }
    if (msg.sessionId === undefined) {
      // Unreachable through link.ts (the schema requires it); never forward connection errors.
      this.dropUnknown(msg);
      return;
    }
    if (msg.searchId !== undefined) {
      const ended = this.tracker.out(msg).some((e) => e.kind === 'search_ended');
      if (!ended) {
        this.dropUnknown(msg);
        return;
      }
      const w = this.infoWindows.get(msg.sessionId);
      if (w && w.searchId === msg.searchId) this.infoWindows.delete(msg.sessionId);
      this.emit(msg);
      return;
    }
    // Session-level error.
    if (this.tracker.openSessions.includes(msg.sessionId)) {
      this.tracker.out(msg);
      this.pendingStops.delete(msg.sessionId);
      this.infoWindows.delete(msg.sessionId);
      this.emit(msg);
      return;
    }
    const pending = this.pendingStops.get(msg.sessionId) ?? 0;
    if (msg.type === 'error' && msg.code === 'session_not_found' && pending > 0) {
      if (pending === 1) this.pendingStops.delete(msg.sessionId);
      else this.pendingStops.set(msg.sessionId, pending - 1);
      this.emit(msg);
      return;
    }
    this.dropUnknown(msg);
  }

  /** The node acknowledged `client.close`, or (unrequested) refused this client. */
  onClientClosed(): void {
    if (this.st === 'closing') {
      this.completeClose();
      return;
    }
    if (this.st !== 'open') return;
    this.log.info({ cid: this.cid, node: this.link.nodeId }, 'relay: node refused the client');
    this.die();
  }

  /**
   * The link to the node is gone (socket closed, missed pongs, `replaced`, revoked, drain
   * deadline): terminal messages for everything open, then the channel is dead. Idempotent.
   */
  onNodeLost(): void {
    if (this.st === 'closing') {
      this.completeClose();
      return;
    }
    if (this.st !== 'open') return;
    this.die();
  }

  // -------------------------------------------------------------------------------------------

  private die(): void {
    const searches = this.tracker.openSearchList();
    const withSearch = new Set(searches.map((s) => s.sessionId));
    const sessions = this.tracker.openSessions.filter((id) => !withSearch.has(id));
    this.st = 'lost';
    this.tracker = new SessionTracker(this.now);
    this.infoWindows.clear();
    this.pendingStops.clear();
    for (const s of searches) {
      this.emit(errorMsg('engine_crashed', 'engine node lost', s.sessionId, s.searchId));
    }
    for (const sessionId of sessions) {
      this.emit(errorMsg('engine_crashed', 'engine node lost', sessionId));
    }
    this.log.info(
      {
        cid: this.cid,
        node: this.link.nodeId,
        searches: searches.length,
        sessions: sessions.length,
      },
      'relay: node lost',
    );
    this.resolveLost();
    this.finish();
  }

  private completeClose(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.st = 'closed';
    this.tracker = new SessionTracker(this.now);
    this.infoWindows.clear();
    this.pendingStops.clear();
    this.resolveClose?.();
    this.resolveClose = null;
    this.finish();
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    try {
      this.opts.onDone?.();
    } catch (err) {
      this.log.warn({ cid: this.cid, err: (err as Error).message }, 'relay: onDone failed');
    }
  }

  private notePendingStop(sessionId: string): void {
    if (!this.pendingStops.has(sessionId) && this.pendingStops.size >= MAX_PENDING_STOPS) {
      const oldest = this.pendingStops.keys().next().value;
      if (oldest !== undefined) this.pendingStops.delete(oldest);
    }
    this.pendingStops.set(sessionId, Math.min((this.pendingStops.get(sessionId) ?? 0) + 1, 1_000));
  }

  private allowInfo(sessionId: string, searchId: number, final: boolean): boolean {
    // The final info carrying the policy distribution (ADR-019) is part of the result.
    if (final) return true;
    const now = this.now();
    let w = this.infoWindows.get(sessionId);
    if (!w || w.searchId !== searchId || now - w.windowStart >= 1_000) {
      w = { searchId, windowStart: now, count: 0 };
      this.infoWindows.set(sessionId, w);
    }
    if (w.count >= this.infoPerSecond) {
      if (this.counters.infoRate++ % 1_000 === 0) {
        this.log.debug(
          { cid: this.cid, node: this.link.nodeId, dropped: this.counters.infoRate },
          'relay: info above the per-search rate dropped',
        );
      }
      return false;
    }
    w.count++;
    return true;
  }

  private dropUnknown(msg: NodeRelayMessage): void {
    if (this.counters.unknown++ % 100 === 0) {
      this.log.warn(
        {
          cid: this.cid,
          node: this.link.nodeId,
          type: msg.type,
          total: this.counters.unknown,
        },
        'relay: node message for an unknown session or search dropped',
      );
    }
  }

  private emit(msg: NodeRelayMessage): void {
    this.counters.delivered++;
    try {
      this.deliver(msg);
    } catch (err) {
      this.log.warn({ cid: this.cid, err: (err as Error).message }, 'relay: deliver failed');
    }
  }
}

function errorMsg(
  code: ProtocolErrorCode,
  message: string,
  sessionId: string,
  searchId?: number,
): ErrorMessage {
  const msg: ErrorMessage = { type: 'error', code, message, sessionId };
  if (searchId !== undefined) msg.searchId = searchId;
  return msg;
}
