import WebSocket, { type RawData } from 'ws';
import {
  PROTOCOL_VERSION,
  SearchIdSchema,
  ServerMessageSchema,
  SessionIdSchema,
  parseClientMessage,
  type AnalyzeMessage,
  type ClientMessage,
  type ErrorMessage,
  type HelloMessage,
  type ProtocolErrorCode,
  type ReleaseMessage,
  type ServerMessage,
  type StopMessage,
  type WelcomeMessage,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import type { RoomClient, RoomManager } from '../rooms/RoomManager.js';
import type { ReviewService } from '../review/ReviewService.js';
import type { AnalysisChannel } from '../sessions/AnalysisChannel.js';
import {
  deniedWithValidToken,
  type AnalysisRouter,
  type RouteResult,
} from '../sessions/AnalysisRouter.js';
import { allowRate, type RateLimit } from '../sessions/rateLimit.js';
import { tokenMatches } from './token.js';
import type { BadTokenLimiter } from './badTokens.js';

export { tokenMatches };
export type { RateLimit };

export interface ConnectionOptions {
  /**
   * Decides at `hello` where this connection's analysis runs (ADR-020 relay layering §2):
   * `LocalRouter` (standalone) or `HubRouter` (ROLE=hub). A denied route gives the restricted
   * welcome (no engines, `capabilities.analysis: false`, `analysisDenied`, `analyze` →
   * `unauthorized`); rooms and review reads keep working.
   */
  router: AnalysisRouter;
  serverVersion: string;
  logger: PoolLogger;
  /** Close the socket if no `hello` arrives within this time. */
  handshakeTimeoutMs?: number;
  /** All messages per window; exceeding it closes the connection. */
  messageRateLimit?: RateLimit;
  /** `info` messages are dropped (never terminal messages) while the socket buffers more than this. */
  maxBufferedBytes?: number;
  /** Rooms of this server (ADR-013). */
  rooms: RoomManager;
  /** `room.*` messages per window. Default 10 per second. */
  roomRateLimit?: RateLimit;
  /** Review store of this server (ADR-017). */
  review: ReviewService;
  /** `review.get` / `review.positions.get` / `review.stats.get` per window. Default 20 per second. */
  reviewGetRateLimit?: RateLimit;
  /** `review.put` / `review.positions.put` per window. Default 20 per 4 s (5/s, bursts of 20). */
  reviewPutRateLimit?: RateLimit;
  /**
   * Per-address counter of `bad_token` answers (ADR-020 §4.1, hub): over its limit a `hello`
   * with a token is answered `rate_limited` and the socket is closed (1008).
   */
  badTokens?: BadTokenLimiter;
}

/** Who a connection is accounted to (per-IP caps live in the router's channels). */
export interface ConnectionPeer {
  /** Resolved client address (see `resolveClientIp`). */
  ip: string;
}

/** Messages buffered while an asynchronous route is pending (beyond: `rate_limited`). */
const MAX_PENDING_WHILE_ROUTING = 64;

type ChannelMessage = AnalyzeMessage | StopMessage | ReleaseMessage;

let nextConnectionId = 1;

/**
 * One WebSocket client (ADR-006): handshake, routing, Origin-independent rate limits, rooms and
 * the review store. At `hello` the {@link AnalysisRouter} decides the route; its
 * {@link AnalysisChannel} (`ClientSessions` on local engines, an accounted relay to a node on the
 * hub) then owns sessions, searches, ordering and the terminal-message guarantee. When the
 * channel is lost (its node went away) the socket is closed with 1012 after the terminal
 * messages went out, and the client reconnects to a fresh route (ADR-020 §3).
 */
export class Connection implements RoomClient {
  readonly id = nextConnectionId++;
  private handshaken = false;
  /** The routed channel; null before `hello` and on a denied route (`analyze` → `unauthorized`). */
  private analysis: AnalysisChannel | null = null;
  /** The token proved valid (review writes allowed): routed, or denied for capacity reasons. */
  private tokenValid = false;
  /** Public id of the token this connection was routed with (hub), or null. */
  private routedTokenId: string | null = null;
  /** Non-null while an asynchronous route is pending: messages that arrived meanwhile. */
  private pending: ClientMessage[] | null = null;
  private closed = false;
  private readonly messageTimes: number[] = [];
  private readonly roomTimes: number[] = [];
  private readonly reviewGetTimes: number[] = [];
  private readonly reviewPutTimes: number[] = [];
  private handshakeTimer: ReturnType<typeof setTimeout> | null;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private droppedInfos = 0;
  /** Heartbeat bookkeeping (managed by the server). */
  isAlive = true;

  private readonly messageRate: RateLimit;
  private readonly roomRate: RateLimit;
  private readonly reviewGetRate: RateLimit;
  private readonly reviewPutRate: RateLimit;
  private readonly maxBufferedBytes: number;
  private readonly log: PoolLogger;

  constructor(
    private readonly ws: WebSocket,
    private readonly opts: ConnectionOptions,
    private readonly peer: ConnectionPeer,
  ) {
    this.messageRate = opts.messageRateLimit ?? { max: 100, windowMs: 1_000 };
    this.roomRate = opts.roomRateLimit ?? { max: 10, windowMs: 1_000 };
    this.reviewGetRate = opts.reviewGetRateLimit ?? { max: 20, windowMs: 1_000 };
    this.reviewPutRate = opts.reviewPutRateLimit ?? { max: 20, windowMs: 4_000 };
    this.maxBufferedBytes = opts.maxBufferedBytes ?? 1024 * 1024;
    this.log = opts.logger;
    this.closedPromise = new Promise((r) => (this.resolveClosed = r));

    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (!this.handshaken) this.close(1008, 'handshake timeout');
    }, opts.handshakeTimeoutMs ?? 10_000);
    this.handshakeTimer.unref?.();

    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('pong', () => (this.isAlive = true));
    ws.on('close', () => this.dispose());
    ws.on('error', (err) => {
      this.log.debug({ conn: this.id, err: err.message }, 'websocket error');
      this.dispose();
    });
  }

  /** Resolves once the socket is closed and every session has stopped and released its engine. */
  whenClosed(): Promise<void> {
    return this.closedPromise;
  }

  /** Closes the socket (with a hard terminate after 1 s) and cleans up. */
  close(code: number, reason: string): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(code, reason);
      setTimeout(() => this.ws.terminate(), 1_000).unref?.();
    }
    this.dispose();
  }

  /** Heartbeat probe; the peer's pong sets {@link isAlive}. */
  ping(): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.ping();
  }

  /** Called by the server's heartbeat. */
  kill(): void {
    this.ws.terminate();
    this.dispose();
  }

  get sessionCount(): number {
    return this.analysis?.sessionCount ?? 0;
  }

  /** Public id of the verified token of this connection's route (hub only), or null. */
  get tokenId(): string | null {
    return this.routedTokenId;
  }

  /** Client address (see `resolveClientIp`). */
  get ip(): string {
    return this.peer.ip;
  }

  /** Sends a message to this client (used by the room manager). */
  deliver(msg: ServerMessage): void {
    this.send(msg);
  }

  /** Fair play: a game started in this connection's room; its engine sessions are dropped. */
  onGameStarted(): void {
    this.analysis?.retireAll();
  }

  // -------------------------------------------------------------------------------------------
  // Incoming

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (!allowRate(this.messageTimes, this.messageRate)) {
      this.sendError('rate_limited', 'too many messages; closing connection');
      this.close(1008, 'rate limited');
      return;
    }
    if (isBinary) {
      this.sendError('invalid_message', 'binary frames are not supported');
      return;
    }
    const text = rawToString(data);
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      const ids = analyzeIdsOf(text);
      this.sendError('invalid_message', parsed.error, ids?.sessionId, ids?.searchId);
      return;
    }
    const msg = parsed.message;
    if (msg.type === 'hello') {
      this.onHello(msg);
      return;
    }
    if (!this.handshaken) {
      const ids = msg.type === 'analyze' ? msg : undefined;
      this.sendError('handshake_required', 'send hello first', ids?.sessionId, ids?.searchId);
      return;
    }
    if (this.pending) {
      // The route is still being decided; keep the order of everything sent after `hello`.
      if (this.pending.length >= MAX_PENDING_WHILE_ROUTING) {
        const ids = msg.type === 'analyze' ? msg : undefined;
        this.sendError(
          'rate_limited',
          'too many messages before welcome',
          ids?.sessionId,
          ids?.searchId,
        );
        return;
      }
      this.pending.push(msg);
      return;
    }
    this.dispatch(msg);
  }

  private onHello(msg: HelloMessage): void {
    if (this.handshaken) {
      this.sendError('invalid_message', 'duplicate hello');
      return;
    }
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.sendError(
        'protocol_mismatch',
        `server speaks protocol ${PROTOCOL_VERSION}, client sent ${msg.protocolVersion}`,
      );
      this.close(1008, 'protocol mismatch');
      return;
    }
    this.handshaken = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.log.debug({ conn: this.id, client: msg.client }, 'handshake');
    if (msg.token !== undefined && this.opts.badTokens?.blocked(this.peer.ip)) {
      this.refuseBadTokens();
      return;
    }
    let result: RouteResult | Promise<RouteResult>;
    try {
      result = this.opts.router.route(msg, { ip: this.peer.ip, connId: this.id });
    } catch (err) {
      this.routeFailed(err);
      return;
    }
    if (isPromise(result)) {
      this.pending = [];
      result.then(
        (r) => this.completeHello(r),
        (err: unknown) => this.routeFailed(err),
      );
      return;
    }
    this.completeHello(result);
  }

  /** Too many bad tokens from this address (ADR-020 §4.1). */
  private refuseBadTokens(): void {
    this.pending = null;
    this.log.warn({ conn: this.id }, 'too many invalid tokens from this address; closing');
    this.sendError('rate_limited', 'too many invalid tokens; try again later');
    this.close(1008, 'rate limited');
  }

  private routeFailed(err: unknown): void {
    this.log.error({ conn: this.id, err: (err as Error)?.message }, 'routing failed');
    this.pending = null;
    if (!this.closed) {
      this.sendError('internal_error', 'routing failed');
      this.close(1011, 'internal error');
    }
  }

  /** Sends the welcome composed from the route, opens the channel, replays buffered messages. */
  private completeHello(result: RouteResult): void {
    if (this.closed) return;
    if (!result.ok && result.reason === 'bad_token' && this.opts.badTokens?.fail(this.peer.ip)) {
      this.refuseBadTokens();
      return;
    }
    this.routedTokenId = result.tokenId ?? null;
    const welcome: WelcomeMessage = {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: this.opts.serverVersion,
      limits: { ...(result.ok ? result.route.limits : this.opts.router.restrictedLimits) },
      engines: result.ok
        ? result.route.engines.map((e) => ({ ...e, defaults: { ...e.defaults } }))
        : [],
      capabilities: {
        analysis: result.ok,
        rooms: true,
        reviewStore: this.opts.review.enabled,
      },
    };
    if (result.ok && result.route.node) welcome.node = { ...result.route.node };
    if (!result.ok) {
      welcome.analysisDenied = result.reason;
      this.log.debug({ conn: this.id, reason: result.reason }, 'analysis denied at hello');
    }
    this.tokenValid = result.ok || deniedWithValidToken(result.reason);
    this.send(welcome);
    if (result.ok) {
      try {
        this.analysis = result.route.open((m) => this.send(m), { ip: this.peer.ip, id: this.id });
      } catch (err) {
        this.routeFailed(err);
        return;
      }
      const channel = this.analysis;
      void channel.lost?.then(() => {
        if (this.closed || this.analysis !== channel) return;
        this.log.info({ conn: this.id }, 'analysis channel lost: closing 1012');
        this.close(1012, 'engine node lost');
      });
    }
    const pending = this.pending;
    this.pending = null;
    for (const m of pending ?? []) {
      if (this.closed) return;
      this.dispatch(m);
    }
  }

  private dispatch(msg: ClientMessage): void {
    switch (msg.type) {
      case 'analyze':
        if (!this.analysis) {
          this.sendError(
            'unauthorized',
            'access token required or wrong',
            msg.sessionId,
            msg.searchId,
          );
          return;
        }
        // Fair play (ADR-013), for every kind of channel: checked before anything else.
        if (this.opts.rooms.isPlaying(this)) {
          this.sendError(
            'forbidden',
            'no analysis while you play in a room',
            msg.sessionId,
            msg.searchId,
          );
          return;
        }
        this.handleChannel(msg);
        break;
      case 'stop':
      case 'release':
        this.handleChannel(msg);
        break;
      case 'ping':
        this.send(msg.t === undefined ? { type: 'pong' } : { type: 'pong', t: msg.t });
        break;
      case 'room.create':
      case 'room.join':
      case 'room.attach':
      case 'room.move':
      case 'room.resign':
      case 'room.draw':
      case 'room.abort':
      case 'room.claim':
      case 'room.leave':
        if (!allowRate(this.roomTimes, this.roomRate)) {
          this.sendError('rate_limited', 'too many room requests');
          return;
        }
        this.opts.rooms.handle(this, msg);
        break;
      case 'review.get':
      case 'review.positions.get':
      case 'review.stats.get':
        if (!allowRate(this.reviewGetTimes, this.reviewGetRate)) {
          this.sendError('rate_limited', 'too many review requests');
          return;
        }
        this.send(this.opts.review.handle(this.reviewContext(), msg));
        break;
      case 'review.put':
      case 'review.positions.put':
        if (!allowRate(this.reviewPutTimes, this.reviewPutRate)) {
          this.sendError('rate_limited', 'too many review writes');
          return;
        }
        this.send(this.opts.review.handle(this.reviewContext(), msg));
        break;
    }
  }

  /**
   * `stop`/`release` without a channel behave as on a server where the session never existed
   * (`release` is silent, `stop` → `session_not_found`), as `ClientSessions` answers them.
   */
  private handleChannel(msg: ChannelMessage): void {
    if (this.analysis) {
      this.analysis.handle(msg);
      return;
    }
    if (msg.type === 'stop') {
      this.sendError('session_not_found', `no session "${msg.sessionId}"`, msg.sessionId);
    }
  }

  private reviewContext(): { id: number; ip: string; analysisAllowed: boolean } {
    return { id: this.id, ip: this.peer.ip, analysisAllowed: this.tokenValid };
  }

  // -------------------------------------------------------------------------------------------
  // Outgoing

  private errorMessage(
    code: ProtocolErrorCode,
    message: string,
    sessionId?: string,
    searchId?: number,
  ): ErrorMessage {
    const msg: ErrorMessage = { type: 'error', code, message: message.slice(0, 1_000) };
    if (sessionId !== undefined) {
      msg.sessionId = sessionId;
      if (searchId !== undefined) msg.searchId = searchId;
    }
    return msg;
  }

  private sendError(
    code: ProtocolErrorCode,
    message: string,
    sessionId?: string,
    searchId?: number,
  ): void {
    this.send(this.errorMessage(code, message, sessionId, searchId));
  }

  /**
   * Validates every outgoing message with `ServerMessageSchema` (always on: a few µs per message
   * at engine `info` rates, and it keeps a misbehaving engine from producing off-contract frames).
   * `info` is dropped under backpressure; terminal and error messages never are.
   */
  private send(msg: ServerMessage): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    const check = ServerMessageSchema.safeParse(msg);
    if (!check.success) {
      this.log.warn(
        { conn: this.id, type: msg.type, issues: check.error.issues.slice(0, 3) },
        'dropping invalid outgoing message',
      );
      return false;
    }
    if (msg.type === 'info' && this.ws.bufferedAmount > this.maxBufferedBytes) {
      if (this.droppedInfos++ % 100 === 0) {
        this.log.debug(
          { conn: this.id, dropped: this.droppedInfos },
          'backpressure: dropping info',
        );
      }
      return false;
    }
    this.ws.send(JSON.stringify(check.data));
    return true;
  }

  // -------------------------------------------------------------------------------------------

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.pending = null;
    this.opts.rooms.disconnect(this);
    const channel = this.analysis;
    if (channel) void channel.close().then(() => this.resolveClosed());
    else this.resolveClosed();
    this.log.debug({ conn: this.id }, 'connection closed');
  }
}

function isPromise<T>(v: T | Promise<T>): v is Promise<T> {
  return typeof (v as { then?: unknown } | null)?.then === 'function';
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/** Best effort: ids of an invalid `analyze`, so the client can settle the right handle. */
function analyzeIdsOf(text: string): { sessionId: string; searchId?: number } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.type !== 'analyze') return undefined;
  const sid = SessionIdSchema.safeParse(v.sessionId);
  if (!sid.success) return undefined;
  const search = SearchIdSchema.safeParse(v.searchId);
  return search.success ? { sessionId: sid.data, searchId: search.data } : { sessionId: sid.data };
}
