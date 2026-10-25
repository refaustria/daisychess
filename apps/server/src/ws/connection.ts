import WebSocket, { type RawData } from 'ws';
import {
  PROTOCOL_VERSION,
  SearchIdSchema,
  ServerMessageSchema,
  SessionIdSchema,
  parseClientMessage,
  type EngineDescriptor,
  type ErrorMessage,
  type Limits,
  type ProtocolErrorCode,
  type ServerMessage,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import type { IpSessionLedger } from './clientIp.js';
import type { RoomClient, RoomManager } from '../rooms/RoomManager.js';
import type { ReviewService } from '../review/ReviewService.js';
import type { AnalysisBackend } from '../sessions/AnalysisBackend.js';
import { ClientSessions } from '../sessions/ClientSessions.js';
import { allowRate, type RateLimit } from '../sessions/rateLimit.js';
import { tokenMatches } from './token.js';

export { tokenMatches };
export type { RateLimit };

export interface ConnectionOptions {
  /** Where analysis sessions lease their engines (`LocalBackend` over the pool). */
  backend: AnalysisBackend;
  limits: Limits;
  /** Engines as announced in `welcome` (disabled ones are rejected with `unknown_engine`). */
  engines: readonly EngineDescriptor[];
  serverVersion: string;
  logger: PoolLogger;
  /** A session without a running search releases its lease after this long. */
  sessionIdleMs: number;
  /** Time an engine gets to answer `stop` with `bestmove` before it is considered hung. */
  stopTimeoutMs?: number;
  /** Close the socket if no `hello` arrives within this time. */
  handshakeTimeoutMs?: number;
  /** `analyze` messages per window (ADR-006 / M3-2: 20 per second). */
  analyzeRateLimit?: RateLimit;
  /** All messages per window; exceeding it closes the connection. */
  messageRateLimit?: RateLimit;
  /** `info` messages are dropped (never terminal messages) while the socket buffers more than this. */
  maxBufferedBytes?: number;
  /**
   * When set (non-empty), a `hello` whose `token` does not equal it gets a restricted welcome
   * (ADR-010/013): no engines, `capabilities.analysis: false`, `analyze` → `unauthorized`.
   */
  accessToken?: string | null;
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
}

/** Who a connection is accounted to for the per-IP session cap. */
export interface ConnectionPeer {
  /** Resolved client address (see `resolveClientIp`). */
  ip: string;
  /** Shared by all connections of one server. */
  ledger: IpSessionLedger;
}

let nextConnectionId = 1;

/**
 * One WebSocket client (ADR-006): handshake, access token, Origin-independent rate limits, rooms
 * and the review store. Analysis messages (`analyze`/`stop`/`release`) are delegated to a
 * transport-agnostic {@link ClientSessions}, which owns sessions, searches, leases, ordering and
 * the terminal-message guarantee.
 */
export class Connection implements RoomClient {
  readonly id = nextConnectionId++;
  private handshaken = false;
  /** False on a token-protected server when this connection's `hello.token` was missing/wrong. */
  private analysisAllowed = true;
  private closed = false;
  private readonly analysis: ClientSessions;
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
    this.analysis = new ClientSessions(
      (msg) => this.send(msg),
      { ip: peer.ip, id: this.id },
      {
        backend: opts.backend,
        limits: opts.limits,
        engines: opts.engines,
        logger: opts.logger,
        ledger: peer.ledger,
        sessionIdleMs: opts.sessionIdleMs,
        ...(opts.stopTimeoutMs !== undefined ? { stopTimeoutMs: opts.stopTimeoutMs } : {}),
        ...(opts.analyzeRateLimit ? { analyzeRateLimit: opts.analyzeRateLimit } : {}),
        forbidden: () =>
          this.opts.rooms.isPlaying(this) ? 'no analysis while you play in a room' : null,
      },
    );

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
    return this.analysis.sessionCount;
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
    this.analysis.retireAll();
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
      const required = this.opts.accessToken;
      if (required && !tokenMatches(msg.token, required)) {
        // Restricted mode (ADR-013): rooms work, analysis does not. Never log the token itself,
        // only whether one was sent.
        this.analysisAllowed = false;
        this.log.info(
          { conn: this.id, tokenSent: msg.token !== undefined },
          'handshake without a valid access token: restricted to rooms',
        );
      }
      this.handshaken = true;
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.log.debug({ conn: this.id, client: msg.client }, 'handshake');
      this.send({
        type: 'welcome',
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: this.opts.serverVersion,
        limits: { ...this.opts.limits },
        engines: this.analysisAllowed
          ? this.opts.engines.map((e) => ({ ...e, defaults: { ...e.defaults } }))
          : [],
        capabilities: {
          analysis: this.analysisAllowed,
          rooms: true,
          reviewStore: this.opts.review.enabled,
        },
      });
      return;
    }
    if (!this.handshaken) {
      const ids = msg.type === 'analyze' ? msg : undefined;
      this.sendError('handshake_required', 'send hello first', ids?.sessionId, ids?.searchId);
      return;
    }
    switch (msg.type) {
      case 'analyze':
        if (!this.analysisAllowed) {
          this.sendError(
            'unauthorized',
            'access token required or wrong',
            msg.sessionId,
            msg.searchId,
          );
          return;
        }
        this.analysis.handle(msg);
        break;
      case 'stop':
      case 'release':
        this.analysis.handle(msg);
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

  private reviewContext(): { id: number; ip: string; analysisAllowed: boolean } {
    return { id: this.id, ip: this.peer.ip, analysisAllowed: this.analysisAllowed };
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
    this.opts.rooms.disconnect(this);
    void this.analysis.close().then(() => this.resolveClosed());
    this.log.debug({ conn: this.id }, 'connection closed');
  }
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
