import WebSocket, { type RawData } from 'ws';
import {
  BestMoveSchema,
  PROTOCOL_VERSION,
  SearchIdSchema,
  ServerMessageSchema,
  SessionIdSchema,
  checkAnalyzeLimits,
  parseClientMessage,
  type AnalyzeMessage,
  type BestMove,
  type BestMoveMessage,
  type EngineDescriptor,
  type EngineInfo,
  type ErrorMessage,
  type Limits,
  type ProtocolErrorCode,
  type ServerMessage,
} from '@daisychess/engine-core';
import type { EnginePool, Lease, PoolLogger } from '../engines/EnginePool.js';
import type { ExitInfo, GoParams } from '../engines/UciProcess.js';
import type { IpSessionLedger } from './clientIp.js';
import type { RoomClient, RoomManager } from '../rooms/RoomManager.js';
import type { ReviewService } from '../review/ReviewService.js';
import { tokenMatches } from './token.js';

export { tokenMatches };

export interface RateLimit {
  max: number;
  windowMs: number;
}

export interface ConnectionOptions {
  pool: EnginePool;
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

type TerminalMessage = BestMoveMessage | ErrorMessage;

interface Search {
  readonly searchId: number;
  terminated: boolean;
  stopReason: 'stopped' | 'limit' | null;
  readonly done: Promise<void>;
  resolveDone: () => void;
  capTimer: ReturnType<typeof setTimeout> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

interface Session {
  readonly id: string;
  lease: Lease | null;
  offExit: (() => void) | null;
  current: Search | null;
  /** searchId of the most recent accepted `analyze`; 0 after `stop`/`release`. */
  latest: number;
  /** Serialises every operation on this session (analyze, stop, release, idle release). */
  chain: Promise<void>;
  pending: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  retired: boolean;
  /** Holds one of the client address's slots in the per-IP ledger (from acquire to drop). */
  ipSlot: boolean;
}

let nextConnectionId = 1;

/**
 * One WebSocket client (ADR-006).
 *
 * Ordering: every operation on a session runs on that session's promise chain. An `analyze`
 * first stops the running search and awaits its terminal message (sent from the `bestmove`
 * handler) before it sends `position`/`go`, so no `info` of the new search can precede the old
 * search's `bestmove`. Each search has a single `finishSearch()` guarded by a flag, which is the
 * only place terminal messages are sent: exactly one per accepted search. Queued `analyze`s that
 * were superseded before they started are terminated with `bestmove null, reason: stopped`
 * without ever reaching the engine.
 */
export class Connection implements RoomClient {
  readonly id = nextConnectionId++;
  private handshaken = false;
  /** False on a token-protected server when this connection's `hello.token` was missing/wrong. */
  private analysisAllowed = true;
  private closed = false;
  private readonly sessions = new Map<string, Session>();
  /** Chains of released sessions still stopping/returning their engine, by sessionId. */
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly analyzeTimes: number[] = [];
  private readonly messageTimes: number[] = [];
  private readonly roomTimes: number[] = [];
  private readonly reviewGetTimes: number[] = [];
  private readonly reviewPutTimes: number[] = [];
  private handshakeTimer: ReturnType<typeof setTimeout> | null;
  private readonly enginesById: Map<string, EngineDescriptor>;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private droppedInfos = 0;
  /** Heartbeat bookkeeping (managed by the server). */
  isAlive = true;

  private readonly stopTimeoutMs: number;
  private readonly analyzeRate: RateLimit;
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
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 5_000;
    this.analyzeRate = opts.analyzeRateLimit ?? { max: 20, windowMs: 1_000 };
    this.messageRate = opts.messageRateLimit ?? { max: 100, windowMs: 1_000 };
    this.roomRate = opts.roomRateLimit ?? { max: 10, windowMs: 1_000 };
    this.reviewGetRate = opts.reviewGetRateLimit ?? { max: 20, windowMs: 1_000 };
    this.reviewPutRate = opts.reviewPutRateLimit ?? { max: 20, windowMs: 4_000 };
    this.maxBufferedBytes = opts.maxBufferedBytes ?? 1024 * 1024;
    this.log = opts.logger;
    this.enginesById = new Map(opts.engines.map((e) => [e.id, e]));
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
    return this.sessions.size;
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
    for (const session of [...this.sessions.values()]) this.retire(session);
  }

  // -------------------------------------------------------------------------------------------
  // Incoming

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (!this.allow(this.messageTimes, this.messageRate)) {
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
        this.onAnalyze(msg);
        break;
      case 'stop':
        this.onStop(msg.sessionId);
        break;
      case 'release':
        this.onRelease(msg.sessionId);
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
        if (!this.allow(this.roomTimes, this.roomRate)) {
          this.sendError('rate_limited', 'too many room requests');
          return;
        }
        this.opts.rooms.handle(this, msg);
        break;
      case 'review.get':
      case 'review.positions.get':
      case 'review.stats.get':
        if (!this.allow(this.reviewGetTimes, this.reviewGetRate)) {
          this.sendError('rate_limited', 'too many review requests');
          return;
        }
        this.send(this.opts.review.handle(this.reviewContext(), msg));
        break;
      case 'review.put':
      case 'review.positions.put':
        if (!this.allow(this.reviewPutTimes, this.reviewPutRate)) {
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

  private onAnalyze(msg: AnalyzeMessage): void {
    const { sessionId, searchId } = msg;
    if (!this.analysisAllowed) {
      this.sendError('unauthorized', 'access token required or wrong', sessionId, searchId);
      return;
    }
    if (this.opts.rooms.isPlaying(this)) {
      this.sendError('forbidden', 'no analysis while you play in a room', sessionId, searchId);
      return;
    }
    if (!this.allow(this.analyzeTimes, this.analyzeRate)) {
      this.sendError('rate_limited', 'too many analyze requests', sessionId, searchId);
      return;
    }
    const engine = this.enginesById.get(msg.engine);
    if (!engine || !engine.enabled) {
      this.sendError('unknown_engine', `unknown engine "${msg.engine}"`, sessionId, searchId);
      return;
    }
    const violation = checkAnalyzeLimits(msg, this.opts.limits);
    if (violation) {
      this.sendError('limit_exceeded', violation, sessionId, searchId);
      return;
    }
    let session = this.sessions.get(sessionId);
    if (!session) {
      if (this.sessions.size >= this.opts.limits.maxSessionsPerConnection) {
        this.sendError(
          'limit_exceeded',
          `at most ${this.opts.limits.maxSessionsPerConnection} sessions per connection`,
          sessionId,
          searchId,
        );
        return;
      }
      session = this.createSession(sessionId);
    }
    session.latest = searchId;
    const s = session;
    this.enqueue(s, () => this.runAnalyze(s, msg, engine));
  }

  private onStop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.sendError('session_not_found', `no session "${sessionId}"`, sessionId);
      return;
    }
    session.latest = 0; // queued analyzes of this session are superseded
    this.enqueue(session, () => this.stopCurrent(session, 'stopped'));
  }

  private onRelease(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) this.retire(session);
  }

  // -------------------------------------------------------------------------------------------
  // Sessions

  private createSession(id: string): Session {
    const session: Session = {
      id,
      lease: null,
      offExit: null,
      current: null,
      latest: 0,
      // A released session with the same id may still be finishing; keep the order.
      chain: this.retiring.get(id) ?? Promise.resolve(),
      pending: 0,
      idleTimer: null,
      retired: false,
      ipSlot: false,
    };
    this.sessions.set(id, session);
    return session;
  }

  /** Removes the session from the connection; stops its search and returns its engine. */
  private retire(session: Session): Promise<void> {
    this.sessions.delete(session.id);
    session.retired = true;
    session.latest = 0;
    this.clearIdleTimer(session);
    const p = this.enqueue(session, async () => {
      await this.stopCurrent(session, 'stopped');
      this.dropLease(session);
    });
    this.retiring.set(session.id, p);
    void p.then(() => {
      if (this.retiring.get(session.id) === p) this.retiring.delete(session.id);
    });
    return p;
  }

  private enqueue(session: Session, op: () => Promise<void>): Promise<void> {
    this.clearIdleTimer(session);
    session.pending++;
    const run = async () => {
      try {
        await op();
      } catch (err) {
        this.log.error({ conn: this.id, session: session.id, err }, 'session operation failed');
      } finally {
        session.pending--;
        this.maybeArmIdleTimer(session);
      }
    };
    session.chain = session.chain.then(run, run);
    return session.chain;
  }

  private maybeArmIdleTimer(session: Session): void {
    if (session.retired || this.closed || session.pending > 0 || !session.lease) return;
    if (session.current && !session.current.terminated) return;
    this.clearIdleTimer(session);
    const t = setTimeout(() => {
      session.idleTimer = null;
      this.enqueue(session, async () => {
        if (session.pending > 1) return; // new work arrived meanwhile
        if (session.current && !session.current.terminated) return;
        this.log.debug({ conn: this.id, session: session.id }, 'idle session releases engine');
        this.dropLease(session);
      });
    }, this.opts.sessionIdleMs);
    t.unref?.();
    session.idleTimer = t;
  }

  private clearIdleTimer(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  private attachLease(session: Session, lease: Lease): void {
    session.lease = lease;
    session.offExit = lease.engine.onExit((exit) => this.onEngineExit(session, lease, exit));
  }

  /** Gives the engine back to the pool (which resets or kills it in the background). */
  private dropLease(session: Session): void {
    this.releaseIpSlot(session);
    const lease = session.lease;
    if (!lease) return;
    session.lease = null;
    session.offExit?.();
    session.offExit = null;
    void this.opts.pool.release(lease);
  }

  private releaseIpSlot(session: Session): void {
    if (!session.ipSlot) return;
    session.ipSlot = false;
    this.peer.ledger.release(this.peer.ip);
  }

  private onEngineExit(session: Session, lease: Lease, exit: ExitInfo): void {
    if (session.lease !== lease) return;
    this.dropLease(session);
    this.log.warn(
      {
        conn: this.id,
        session: session.id,
        pid: lease.engine.pid,
        code: exit.code,
        signal: exit.signal,
      },
      'engine crashed during session',
    );
    const s = session.current;
    if (s && !s.terminated) {
      this.finishSearch(
        session,
        s,
        this.errorMessage('engine_crashed', 'engine process crashed', session.id, s.searchId),
      );
    } else if (!session.retired) {
      this.sendError('engine_crashed', 'engine process crashed', session.id);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Searches

  private async runAnalyze(
    session: Session,
    msg: AnalyzeMessage,
    engine: EngineDescriptor,
  ): Promise<void> {
    const { searchId } = msg;
    await this.stopCurrent(session, 'stopped');
    if (this.closed) return;
    if (session.latest !== searchId) {
      this.sendTerminalNow(session.id, searchId);
      return;
    }
    if (session.lease && session.lease.engineId !== msg.engine) this.dropLease(session);
    if (!session.lease) {
      // Per-IP cap: reserved synchronously before the (async) acquire, so concurrent sessions
      // of other connections from the same address cannot overshoot it.
      if (!session.ipSlot) {
        if (!this.peer.ledger.tryReserve(this.peer.ip)) {
          this.log.info(
            { conn: this.id, session: session.id, ip: this.peer.ip },
            'per-address session cap reached',
          );
          this.sendError(
            'no_capacity',
            `too many sessions from your address (at most ${this.peer.ledger.maxPerIp})`,
            session.id,
            searchId,
          );
          return;
        }
        session.ipSlot = true;
      }
      const res = await this.opts.pool.acquire(msg.engine);
      if (!res.ok) {
        this.releaseIpSlot(session);
        this.sendError(res.code, res.message, session.id, searchId);
        return;
      }
      if (this.closed || session.retired) {
        this.releaseIpSlot(session);
        void this.opts.pool.release(res.lease);
        if (!this.closed) this.sendTerminalNow(session.id, searchId);
        return;
      }
      this.attachLease(session, res.lease);
      this.log.info(
        { conn: this.id, session: session.id, engine: msg.engine, pid: res.lease.engine.pid },
        'session leased engine',
      );
    }
    const lease = session.lease;
    if (!lease) return;
    const proc = lease.engine;
    const search = this.createSearch(searchId);
    session.current = search;
    try {
      await proc.setOptions({
        Threads: msg.threads ?? engine.defaults.threads,
        Hash: msg.hash ?? engine.defaults.hash,
        MultiPV: msg.multipv ?? 1,
      });
      if (search.terminated) return; // crashed meanwhile
      if (session.latest !== searchId || session.lease !== lease) {
        this.finishSearch(
          session,
          search,
          this.bestMoveMessage(session.id, searchId, null, 'stopped'),
        );
        return;
      }
      this.log.debug({ conn: this.id, session: session.id, searchId, fen: msg.fen }, 'go');
      proc.position(msg.fen);
      const params: GoParams = {};
      if (msg.depth !== undefined) params.depth = msg.depth;
      if (msg.movetime !== undefined) params.movetime = msg.movetime;
      const result = proc.go(params, (info) => this.onInfo(session, search, info));
      result.then(
        (r) => {
          this.opts.pool.reportHealthy(lease);
          this.finishSearch(
            session,
            search,
            this.bestMoveMessage(
              session.id,
              searchId,
              r.bestMove,
              search.stopReason ?? 'completed',
            ),
          );
        },
        () =>
          this.finishSearch(
            session,
            search,
            this.errorMessage('engine_crashed', 'engine process crashed', session.id, searchId),
          ),
      );
      // Wall-clock cap for every search (infinite ones in particular).
      const cap =
        msg.movetime !== undefined ? msg.movetime + 2_000 : this.opts.limits.maxMovetimeMs;
      search.capTimer = setTimeout(() => this.requestStop(session, search, 'limit'), cap);
      search.capTimer.unref?.();
    } catch (err) {
      if (search.terminated) return;
      this.log.warn(
        { conn: this.id, session: session.id, err: (err as Error).message },
        'engine failed to start search',
      );
      this.finishSearch(
        session,
        search,
        this.errorMessage('engine_crashed', 'engine not responding', session.id, searchId),
      );
      this.dropLease(session); // the pool kills it if it stays unresponsive
    }
  }

  private onInfo(session: Session, search: Search, info: EngineInfo): void {
    if (search.terminated || session.current !== search || this.closed) return;
    this.send({ type: 'info', sessionId: session.id, searchId: search.searchId, info });
  }

  private createSearch(searchId: number): Search {
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    return {
      searchId,
      terminated: false,
      stopReason: null,
      done,
      resolveDone,
      capTimer: null,
      stopTimer: null,
    };
  }

  /** Stops the session's running search (if any) and waits until its terminal message is out. */
  private async stopCurrent(session: Session, reason: 'stopped' | 'limit'): Promise<void> {
    const s = session.current;
    if (!s || s.terminated) return;
    this.requestStop(session, s, reason);
    await s.done;
  }

  private requestStop(session: Session, search: Search, reason: 'stopped' | 'limit'): void {
    if (search.terminated) return;
    search.stopReason ??= reason;
    if (search.stopTimer) return;
    const proc = session.lease?.engine;
    if (proc) {
      try {
        // The rejection path is handled by the go() handler in runAnalyze.
        proc.stop().catch(() => {});
      } catch {
        // process already gone; the exit handler terminates the search
      }
    }
    search.stopTimer = setTimeout(() => {
      if (search.terminated) return;
      this.log.warn({ conn: this.id, session: session.id }, 'engine did not answer stop; dropping');
      this.finishSearch(
        session,
        search,
        this.errorMessage('engine_crashed', 'engine not responding', session.id, search.searchId),
      );
      this.dropLease(session); // pool reset times out and kills the process
    }, this.stopTimeoutMs);
    search.stopTimer.unref?.();
  }

  /** The only place a search's terminal message is sent. */
  private finishSearch(session: Session, search: Search, msg: TerminalMessage): void {
    if (search.terminated) return;
    search.terminated = true;
    if (search.capTimer) clearTimeout(search.capTimer);
    if (search.stopTimer) clearTimeout(search.stopTimer);
    if (session.current === search) session.current = null;
    this.send(msg);
    search.resolveDone();
    this.maybeArmIdleTimer(session);
  }

  /** Terminal message for a search that never reached the engine (superseded while queued). */
  private sendTerminalNow(sessionId: string, searchId: number): void {
    this.send(this.bestMoveMessage(sessionId, searchId, null, 'stopped'));
  }

  // -------------------------------------------------------------------------------------------
  // Outgoing

  private bestMoveMessage(
    sessionId: string,
    searchId: number,
    bestMove: BestMove | null,
    reason: BestMoveMessage['reason'],
  ): BestMoveMessage {
    // A move the schema cannot represent (should not happen with standard chess) becomes null.
    const valid = bestMove && BestMoveSchema.safeParse(bestMove).success ? bestMove : null;
    return { type: 'bestmove', sessionId, searchId, bestMove: valid, reason };
  }

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

  private allow(times: number[], limit: RateLimit): boolean {
    const now = Date.now();
    while (times.length > 0 && now - times[0]! >= limit.windowMs) times.shift();
    if (times.length >= limit.max) return false;
    times.push(now);
    return true;
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.opts.rooms.disconnect(this);
    const pending = [...this.sessions.values()].map((s) => this.retire(s));
    pending.push(...this.retiring.values());
    void Promise.allSettled(pending).then(() => this.resolveClosed());
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
