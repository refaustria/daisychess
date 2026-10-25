import {
  BestMoveSchema,
  checkAnalyzeLimits,
  resolveEngineNodes,
  type AnalyzeMessage,
  type BestMove,
  type BestMoveMessage,
  type EngineDescriptor,
  type EngineInfo,
  type ErrorMessage,
  type InfoMessage,
  type Limits,
  type ProtocolErrorCode,
  type ReleaseMessage,
  type StopMessage,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import type { ExitInfo, GoParams } from '../engines/UciProcess.js';
import type { AnalysisBackend, BackendLease } from './AnalysisBackend.js';
import type { AnalysisChannel } from './AnalysisChannel.js';
import { allowRate, type RateLimit } from './rateLimit.js';

/** Who the sessions belong to: the client address (per-IP cap) and an id for logs. */
export interface SessionPeer {
  /** Resolved client address (see `resolveClientIp`); the per-IP ledger key. */
  ip: string;
  /** Connection id (standalone) or link `cid` (node); used in logs and passed to the backend. */
  id: number | string;
}

/** Per-address session cap shared by all clients of one server (`IpSessionLedger`). */
export interface SessionLedger {
  readonly maxPerIp: number;
  /** Takes a slot for `ip` synchronously; false at the cap. */
  tryReserve(ip: string): boolean;
  release(ip: string): void;
}

/** Client → server messages handled by {@link ClientSessions}. */
export type AnalysisClientMessage = AnalyzeMessage | StopMessage | ReleaseMessage;
/** Server → client messages produced by {@link ClientSessions}. */
export type AnalysisServerMessage = InfoMessage | BestMoveMessage | ErrorMessage;
export type Deliver = (msg: AnalysisServerMessage) => void;

export interface ClientSessionsOptions {
  backend: AnalysisBackend;
  limits: Limits;
  /** Engines as announced in `welcome` (disabled or unknown ones → `unknown_engine`). */
  engines: readonly EngineDescriptor[];
  logger: PoolLogger;
  /** Per-address session cap; shared across every `ClientSessions` of the server. */
  ledger: SessionLedger;
  /** A session without a running search releases its lease after this long. */
  sessionIdleMs: number;
  /** Time an engine gets to answer `stop` with `bestmove` before it is considered hung. Default 5 s. */
  stopTimeoutMs?: number;
  /** `analyze` messages per window (ADR-006 / M3-2). Default 20 per second. */
  analyzeRateLimit?: RateLimit;
  /**
   * Fair-play hook (ADR-013): checked first for every `analyze`; a returned string rejects it
   * with `error forbidden` and that message. Default: never forbidden.
   */
  forbidden?: () => string | null;
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
  /** Most recent relayed `info` of this search; re-sent with `policy` before `bestmove` (ADR-019). */
  lastInfo: EngineInfo | null;
}

interface Session {
  readonly id: string;
  lease: BackendLease | null;
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

/**
 * The analysis state machine of one client (ADR-006), independent of the transport: messages
 * come in through {@link handle}, go out through `deliver`.
 *
 * Ordering: every operation on a session runs on that session's promise chain. An `analyze`
 * first stops the running search and awaits its terminal message (sent from the `bestmove`
 * handler) before it sends `position`/`go`, so no `info` of the new search can precede the old
 * search's `bestmove`. Each search has a single `finishSearch()` guarded by a flag, which is the
 * only place terminal messages are sent: exactly one per accepted search. Queued `analyze`s that
 * were superseded before they started are terminated with `bestmove null, reason: stopped`
 * without ever reaching the engine. After {@link close} nothing is delivered any more.
 */
export class ClientSessions implements AnalysisChannel {
  private closed = false;
  private readonly sessions = new Map<string, Session>();
  /** Chains of released sessions still stopping/returning their engine, by sessionId. */
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly analyzeTimes: number[] = [];
  private readonly enginesById: Map<string, EngineDescriptor>;
  private readonly stopTimeoutMs: number;
  private readonly analyzeRate: RateLimit;
  private readonly log: PoolLogger;
  private closedPromise: Promise<void> | null = null;

  constructor(
    private readonly deliver: Deliver,
    private readonly peer: SessionPeer,
    private readonly opts: ClientSessionsOptions,
  ) {
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 5_000;
    this.analyzeRate = opts.analyzeRateLimit ?? { max: 20, windowMs: 1_000 };
    this.log = opts.logger;
    this.enginesById = new Map(opts.engines.map((e) => [e.id, e]));
  }

  /** Open sessions (retiring ones excluded). */
  get sessionCount(): number {
    return this.sessions.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Dispatches one validated client message. Ignored after {@link close}. */
  handle(msg: AnalysisClientMessage): void {
    if (this.closed) return;
    switch (msg.type) {
      case 'analyze':
        this.analyze(msg);
        break;
      case 'stop':
        this.stop(msg.sessionId);
        break;
      case 'release':
        this.release(msg.sessionId);
        break;
    }
  }

  /** Fair play: drops every session (a game started in the client's room). */
  retireAll(): void {
    for (const session of [...this.sessions.values()]) this.retire(session);
  }

  /**
   * Stops every search and returns every engine; resolves when all of them are released.
   * Idempotent. No message is delivered once this was called.
   */
  close(): Promise<void> {
    if (this.closedPromise) return this.closedPromise;
    this.closed = true;
    const pending = [...this.sessions.values()].map((s) => this.retire(s));
    pending.push(...this.retiring.values());
    this.closedPromise = Promise.allSettled(pending).then(() => undefined);
    return this.closedPromise;
  }

  // -------------------------------------------------------------------------------------------
  // Incoming

  private analyze(msg: AnalyzeMessage): void {
    const { sessionId, searchId } = msg;
    const forbidden = this.opts.forbidden?.() ?? null;
    if (forbidden !== null) {
      this.sendError('forbidden', forbidden, sessionId, searchId);
      return;
    }
    if (!allowRate(this.analyzeTimes, this.analyzeRate)) {
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
    // Per-engine node cap (ADR-019): Maia never searches more than its policy move.
    const nodes = resolveEngineNodes(msg, engine);
    if (!nodes.ok) {
      this.sendError('limit_exceeded', nodes.message, sessionId, searchId);
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

  private stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.sendError('session_not_found', `no session "${sessionId}"`, sessionId);
      return;
    }
    session.latest = 0; // queued analyzes of this session are superseded
    this.enqueue(session, () => this.stopCurrent(session, 'stopped'));
  }

  private release(sessionId: string): void {
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

  /** Removes the session; stops its search and returns its engine. */
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
        this.log.error(
          { conn: this.peer.id, session: session.id, err },
          'session operation failed',
        );
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
        this.log.debug({ conn: this.peer.id, session: session.id }, 'idle session releases engine');
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

  private attachLease(session: Session, lease: BackendLease): void {
    session.lease = lease;
    session.offExit = lease.engine.onExit((exit) => this.onEngineExit(session, lease, exit));
  }

  /** Gives the engine back to the backend (which resets or kills it in the background). */
  private dropLease(session: Session): void {
    this.releaseIpSlot(session);
    const lease = session.lease;
    if (!lease) return;
    session.lease = null;
    session.offExit?.();
    session.offExit = null;
    void this.opts.backend.release(lease);
  }

  private releaseIpSlot(session: Session): void {
    if (!session.ipSlot) return;
    session.ipSlot = false;
    this.opts.ledger.release(this.peer.ip);
  }

  private onEngineExit(session: Session, lease: BackendLease, exit: ExitInfo): void {
    if (session.lease !== lease) return;
    this.dropLease(session);
    this.log.warn(
      {
        conn: this.peer.id,
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
      // of other clients from the same address cannot overshoot it.
      if (!session.ipSlot) {
        if (!this.opts.ledger.tryReserve(this.peer.ip)) {
          this.log.info(
            { conn: this.peer.id, session: session.id, ip: this.peer.ip },
            'per-address session cap reached',
          );
          this.sendError(
            'no_capacity',
            `too many sessions from your address (at most ${this.opts.ledger.maxPerIp})`,
            session.id,
            searchId,
          );
          return;
        }
        session.ipSlot = true;
      }
      const res = await this.opts.backend.acquire(msg.engine, {
        peerId: this.peer.id,
        sessionId: session.id,
      });
      if (!res.ok) {
        this.releaseIpSlot(session);
        this.sendError(res.code, res.message, session.id, searchId);
        return;
      }
      if (this.closed || session.retired) {
        this.releaseIpSlot(session);
        void this.opts.backend.release(res.lease);
        if (!this.closed) this.sendTerminalNow(session.id, searchId);
        return;
      }
      this.attachLease(session, res.lease);
      this.log.info(
        { conn: this.peer.id, session: session.id, engine: msg.engine, pid: res.lease.engine.pid },
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
      this.log.debug({ conn: this.peer.id, session: session.id, searchId, fen: msg.fen }, 'go');
      proc.position(msg.fen);
      const params: GoParams = {};
      if (msg.depth !== undefined) params.depth = msg.depth;
      if (msg.movetime !== undefined) params.movetime = msg.movetime;
      // Validated in analyze(); a capped engine (Maia) runs its cap when the client sent none.
      const nodes = resolveEngineNodes(msg, engine);
      if (nodes.ok && nodes.nodes !== undefined) params.nodes = nodes.nodes;
      const result = proc.go(params, (info) => this.onInfo(session, search, info));
      result.then(
        (r) => {
          this.opts.backend.reportHealthy(lease);
          // Policy distribution (ADR-019): one more `info`, the last one plus `policy`.
          if (r.policy && r.policy.length > 0 && search.lastInfo && !search.terminated) {
            this.onInfo(session, search, { ...search.lastInfo, policy: r.policy });
          }
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
        { conn: this.peer.id, session: session.id, err: (err as Error).message },
        'engine failed to start search',
      );
      this.finishSearch(
        session,
        search,
        this.errorMessage('engine_crashed', 'engine not responding', session.id, searchId),
      );
      this.dropLease(session); // the backend kills it if it stays unresponsive
    }
  }

  private onInfo(session: Session, search: Search, info: EngineInfo): void {
    if (search.terminated || session.current !== search || this.closed) return;
    search.lastInfo = info;
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
      lastInfo: null,
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
      this.log.warn(
        { conn: this.peer.id, session: session.id },
        'engine did not answer stop; dropping',
      );
      this.finishSearch(
        session,
        search,
        this.errorMessage('engine_crashed', 'engine not responding', session.id, search.searchId),
      );
      this.dropLease(session); // backend reset times out and kills the process
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

  private send(msg: AnalysisServerMessage): void {
    if (this.closed) return;
    try {
      this.deliver(msg);
    } catch (err) {
      // A transport failure must not break the session chain (and with it the terminal guarantee
      // for the remaining sessions).
      this.log.warn({ conn: this.peer.id, err: (err as Error).message }, 'deliver failed');
    }
  }
}
