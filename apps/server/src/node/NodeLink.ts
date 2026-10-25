import os from 'node:os';
import WebSocket from 'ws';
import {
  ClientMsgFromNodeSchema,
  LINK_BOUNDS,
  LINK_DEFAULTS,
  LINK_PROTOCOL_VERSION,
  MAX_LINK_MESSAGE_BYTES,
  NodeHelloMessageSchema,
  isFatalLinkEnd,
  minLimits,
  nodeVersionStatus,
  parseHubToNodeMessage,
  serializeLinkMessage,
  type ClientOpenMessage,
  type EngineDescriptor,
  type HubToNodeMessage,
  type Limits,
  type LinkCloseReason,
  type NodeDrainReason,
  type NodeEngineStatus,
  type NodeErrorCode,
  type NodeHelloMessage,
  type NodeToHubMessage,
  type NodeWelcomeMessage,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import type { AnalysisBackend, BackendLease } from '../sessions/AnalysisBackend.js';
import {
  ClientSessions,
  type AnalysisServerMessage,
  type Deliver,
} from '../sessions/ClientSessions.js';
import type { RateLimit } from '../sessions/rateLimit.js';
import { SessionTracker } from '../sessions/SessionTracker.js';
import { UnlimitedLedger } from '../sessions/UnlimitedLedger.js';
import { reconnectDelayMs } from './backoff.js';
import { clampEngines } from './limits.js';

/** `WebSocket.OPEN` (kept local so fakes need not import `ws`). */
const OPEN = 1;

/**
 * The part of a `ws` client socket the link uses. `ws.WebSocket` satisfies it; tests may pass a
 * fake through {@link NodeLinkOptions.connect}.
 */
export interface LinkSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: WebSocket.RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'pong', cb: () => void): unknown;
}

export interface NodeLinkOptions {
  /** `wss://…/link` (validated by `checkHubUrl`). */
  hubUrl: string;
  /** `dcn_…` node token. Never logged. */
  token: string;
  /** This node's software version (`node.hello.node.version`). */
  version: string;
  /** Local display name for logs; the hub's name comes back in `node.welcome`. */
  localName?: string | null;
  /** Exactly what a standalone `welcome` would announce. */
  engines: readonly EngineDescriptor[];
  limits: Limits;
  /**
   * Node-wide session cap announced in `node.hello.maxSessions`. It is enforced by the pool
   * (`acquire` → `no_capacity`), so the pool must be built with the same cap.
   */
  maxSessions: number;
  /** `node.hello.pool` (the node's own switch). */
  pool: boolean;
  /** Where sessions lease their engines (`LocalBackend` over this process's pool). */
  backend: AnalysisBackend;
  /** Per-engine status for `node.status` (from `EnginePool.stats()`). */
  engineStatus: () => NodeEngineStatus[];
  logger: PoolLogger;
  sessionIdleMs: number;
  stopTimeoutMs?: number;
  analyzeRateLimit?: RateLimit;
  /**
   * Called once after a fatal link end (`bad_token`, `revoked`, `link_version`, `node_outdated`,
   * `replaced`) with code 1, after every session was closed. Default `process.exit`.
   */
  exit?: (code: number) => void | Promise<void>;
  /** Socket factory (tests). Default: a `ws` client without compression, `maxPayload` 20 KiB. */
  connect?: (url: string) => LinkSocket;
  /** 1-minute load average for `node.status`. Default `os.loadavg()[0]`. */
  load1?: () => number;
  /** Jitter source for the reconnect backoff. Default `Math.random`. */
  random?: () => number;
  /** Clock (ms) for stats and rate windows. Default `Date.now`. */
  now?: () => number;
  platform?: string;
  arch?: string;
  /** Terminate and retry when `node.welcome` does not arrive within this time. Default 15 s. */
  welcomeTimeoutMs?: number;
  /** Upper bound for the drain wait; the hub's `node.welcome.drainMs` applies below it. */
  maxDrainMs?: number;
  /** Drop `info` while the socket buffers more than this. Default `LINK_DEFAULTS.maxBufferedBytes`. */
  maxBufferedBytes?: number;
  /** Per-search `info` cap per second. Default `LINK_DEFAULTS.infoPerSecondPerSearch`. */
  infoPerSecondPerSearch?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Concurrent `cid`s accepted; further `client.open`s are answered with `client.closed`. */
  maxClients?: number;
  /** How long a closing link waits for the hub's close frame before terminating. Default 2 s. */
  closeTimeoutMs?: number;
}

export type LinkState =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'backoff'
  | 'draining'
  | 'stopped'
  | 'fatal';

export interface LinkEnd {
  reason: NodeErrorCode | LinkCloseReason | 'socket_closed' | 'welcome_timeout' | 'heartbeat';
  message: string;
  at: string;
}

/** `/health/detail.link`. Contains nothing secret (no token). */
export interface LinkStats {
  state: LinkState;
  connected: boolean;
  hubUrl: string;
  localName: string | null;
  nodeId: string | null;
  name: string | null;
  hubVersion: string | null;
  pool: boolean | null;
  connectedSince: string | null;
  lastPongAt: string | null;
  /** Engine sessions leased through this link. */
  sessions: number;
  maxSessions: number;
  /** Open `cid`s. */
  clients: number;
  /** Accepted searches still waiting for their terminal message. */
  runningSearches: number;
  /** Consecutive failed (re)connects since the last stable link. */
  attempt: number;
  reconnects: number;
  nextRetryAt: string | null;
  lastEnd: LinkEnd | null;
  counters: {
    unknownCid: number;
    invalidFrames: number;
    droppedInfoRate: number;
    droppedInfoBackpressure: number;
    rejectedClients: number;
  };
}

interface InfoWindow {
  searchId: number;
  windowStart: number;
  count: number;
}

interface LinkClient {
  readonly cid: string;
  readonly socket: LinkSocket;
  readonly sessions: ClientSessions;
  closing: Promise<void> | null;
  /** Message-derived sessions/searches; open searches are still owed a terminal message. */
  readonly tracker: SessionTracker;
  readonly infoWindows: Map<string, InfoWindow>;
}

const FATAL_HINTS: Partial<Record<NodeErrorCode | LinkCloseReason, string>> = {
  bad_token: 'check NODE_TOKEN (copy it again from the portal, or rotate it there)',
  revoked: 'this node was revoked in the portal; create a new node token there',
  link_version: 'update the node (docker pull, or npx -y @daisychess/node@latest)',
  node_outdated: 'update the node (docker pull, or npx -y @daisychess/node@latest)',
  replaced: 'another process is running with this NODE_TOKEN; stop one of them',
};

const DAY_MS = 86_400_000;

/**
 * The node side of the node ⇄ hub link (ADR-020 §3). One outbound WebSocket to the hub; every
 * player connection the hub routes here arrives as a `cid` and gets its own
 * {@link ClientSessions} over the node's pool, so ordering, the one-terminal-message guarantee
 * and the leases behave exactly as on a standalone server.
 *
 * Lifecycle: {@link start} connects; `node.hello` → `node.welcome` → connected (ping/pong +
 * `node.status` every `heartbeatMs`). A non-fatal end (socket loss, `rate_limited`,
 * `invalid_message`, `shutdown`, missed pongs, no welcome) closes every `cid`'s sessions and
 * reconnects with backoff 1–60 s ±20 %, forever. A fatal end closes everything and calls `exit(1)`.
 * {@link drain} (SIGTERM) sends `node.drain`, refuses new `client.open`s, waits for running
 * searches up to `drainMs`, then closes the link; {@link close} stops at once.
 *
 * Outbound backpressure: `info` is dropped while the socket buffers more than 1 MiB and above 60
 * per second per search (a final `info` carrying `policy` is exempt from the rate cap); terminal
 * messages are never dropped while the link is open.
 */
export class NodeLink {
  private state: LinkState = 'idle';
  private socket: LinkSocket | null = null;
  private welcome: NodeWelcomeMessage | null = null;
  private connectedAt: number | null = null;
  private lastPongAt: number | null = null;
  private awaitingPongs = 0;
  private attempt = 0;
  private reconnects = 0;
  private nextRetryAt: number | null = null;
  private lastEnd: LinkEnd | null = null;
  /** Set by `node.error`/`link.close`; consulted when the socket closes. */
  private pendingEnd: { reason: NodeErrorCode | LinkCloseReason; message: string } | null = null;
  private lastUpdateNoticeAt: number | null = null;
  /** The node itself ended the current socket (welcome timeout, missed pongs); already recorded. */
  private localEnd = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private statusQueued = false;
  private lastStatusSessions = -1;

  private readonly clients = new Map<string, LinkClient>();
  /** Close operations of clients (also of previous links) that have not finished yet. */
  private readonly closingClients = new Set<Promise<void>>();
  /** Shared by every cid: nodes never see addresses (relay layering §5). */
  private readonly ledger = new UnlimitedLedger();
  private readonly counters = {
    unknownCid: 0,
    invalidFrames: 0,
    droppedInfoRate: 0,
    droppedInfoBackpressure: 0,
    rejectedClients: 0,
  };

  private draining = false;
  private stopping = false;
  private drainPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private idleWaiters: (() => void)[] = [];
  private closeWaiters: (() => void)[] = [];

  private readonly log: PoolLogger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxBufferedBytes: number;
  private readonly infoPerSecond: number;
  private readonly maxClients: number;
  private readonly connectSocket: (url: string) => LinkSocket;
  /** Leases taken through {@link backend}: `node.status.sessions`, updated synchronously. */
  private readonly leases = new Set<BackendLease>();
  /** `opts.backend`, counting leases so every change triggers a `node.status`. */
  private readonly backend: AnalysisBackend;

  constructor(private readonly opts: NodeLinkOptions) {
    this.log = opts.logger;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? LINK_DEFAULTS.maxBufferedBytes;
    this.infoPerSecond = opts.infoPerSecondPerSearch ?? LINK_DEFAULTS.infoPerSecondPerSearch;
    this.maxClients = opts.maxClients ?? Math.max(16, opts.maxSessions * 16);
    const inner = opts.backend;
    this.backend = {
      acquire: async (engineId, o) => {
        const res = await inner.acquire(engineId, o);
        if (res.ok) {
          this.leases.add(res.lease);
          this.queueStatus();
        }
        return res;
      },
      release: (lease) => {
        if (this.leases.delete(lease)) this.queueStatus();
        return inner.release(lease);
      },
      reportHealthy: (lease) => inner.reportHealthy(lease),
      health: () => inner.health(),
    };
    this.connectSocket =
      opts.connect ??
      ((url) =>
        new WebSocket(url, {
          perMessageDeflate: false,
          maxPayload: MAX_LINK_MESSAGE_BYTES,
          handshakeTimeout: LINK_DEFAULTS.helloTimeoutMs,
        }));
  }

  /** Connects (idempotent). */
  start(): void {
    if (this.state !== 'idle') return;
    this.connect();
  }

  get linkState(): LinkState {
    return this.state;
  }

  /** The current `node.welcome`, or null while not connected. */
  get currentWelcome(): NodeWelcomeMessage | null {
    return this.welcome;
  }

  stats(): LinkStats {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    const connected = this.welcome !== null && this.socket?.readyState === OPEN;
    return {
      state: this.state,
      connected,
      hubUrl: redactUrl(this.opts.hubUrl),
      localName: this.opts.localName ?? null,
      nodeId: this.welcome?.nodeId ?? null,
      name: this.welcome?.name ?? null,
      hubVersion: this.welcome?.hubVersion ?? null,
      pool: this.welcome?.pool ?? null,
      connectedSince: iso(this.connectedAt),
      lastPongAt: iso(this.lastPongAt),
      sessions: this.leases.size,
      maxSessions: this.opts.maxSessions,
      clients: this.clients.size,
      runningSearches: this.runningSearches(),
      attempt: this.attempt,
      reconnects: this.reconnects,
      nextRetryAt: iso(this.nextRetryAt),
      lastEnd: this.lastEnd,
      counters: { ...this.counters },
    };
  }

  /**
   * Graceful stop (SIGTERM): `node.drain`, no new clients, wait for running searches up to the
   * hub's `drainMs` (capped by `maxDrainMs`), then close every session and the link. Resolves
   * when everything is closed. Idempotent.
   */
  drain(reason: NodeDrainReason = 'shutdown'): Promise<void> {
    this.drainPromise ??= this.runDrain(reason);
    return this.drainPromise;
  }

  /** Immediate stop: closes every session and the link, no reconnect. Idempotent. */
  close(): Promise<void> {
    this.closePromise ??= this.shutdown(1001, 'node shutting down');
    return this.closePromise;
  }

  // -------------------------------------------------------------------------------------------
  // Connection lifecycle

  private connect(): void {
    this.clearReconnectTimer();
    this.nextRetryAt = null;
    this.state = 'connecting';
    this.pendingEnd = null;
    this.localEnd = false;
    let socket: LinkSocket;
    try {
      socket = this.connectSocket(this.opts.hubUrl);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'link: cannot create socket');
      this.recordEnd('socket_closed', (err as Error).message);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.log.info({ hub: redactUrl(this.opts.hubUrl) }, 'link: connecting to hub');
    socket.on('open', () => {
      if (socket !== this.socket) return;
      this.onOpen(socket);
    });
    socket.on('message', (data, isBinary) => {
      if (socket !== this.socket) return;
      this.onFrame(socket, data, isBinary);
    });
    socket.on('pong', () => {
      if (socket !== this.socket) return;
      this.awaitingPongs = 0;
      this.lastPongAt = this.now();
    });
    socket.on('error', (err) => {
      if (socket !== this.socket) return;
      this.log.warn({ err: err.message }, 'link: socket error');
    });
    socket.on('close', (code, reason) => this.onSocketClosed(socket, code, reason.toString()));
  }

  private onOpen(socket: LinkSocket): void {
    this.state = 'handshaking';
    const hello: NodeHelloMessage = {
      type: 'node.hello',
      linkVersion: LINK_PROTOCOL_VERSION,
      nodeToken: this.opts.token,
      node: {
        version: this.opts.version,
        platform: (this.opts.platform ?? process.platform).slice(0, 32),
        arch: (this.opts.arch ?? process.arch).slice(0, 32),
      },
      engines: this.opts.engines.slice(0, LINK_BOUNDS.maxEngines).map((e) => ({
        ...e,
        defaults: { ...e.defaults },
      })),
      limits: { ...this.opts.limits },
      maxSessions: this.opts.maxSessions,
      pool: this.opts.pool,
    };
    const check = NodeHelloMessageSchema.safeParse(hello);
    if (!check.success) {
      // A configuration bug (engines/limits out of protocol bounds): the hub will refuse it.
      this.log.error(
        { issues: check.error.issues.slice(0, 3) },
        'link: node.hello does not satisfy the link protocol; check the engine registry and limits',
      );
    }
    if (!this.sendFrame(socket, hello)) {
      socket.terminate();
      return;
    }
    const t = setTimeout(() => {
      this.welcomeTimer = null;
      if (socket !== this.socket || this.state !== 'handshaking') return;
      this.log.warn({}, 'link: no node.welcome from the hub in time; reconnecting');
      this.recordEnd('welcome_timeout', 'no node.welcome in time');
      this.localEnd = true;
      socket.terminate();
    }, this.opts.welcomeTimeoutMs ?? 15_000);
    t.unref?.();
    this.welcomeTimer = t;
  }

  private onSocketClosed(socket: LinkSocket, code: number, reason: string): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearLinkTimers();
    const wasConnectedFor = this.connectedAt === null ? 0 : this.now() - this.connectedAt;
    const welcomed = this.welcome !== null;
    this.welcome = null;
    this.connectedAt = null;
    this.awaitingPongs = 0;
    // The hub ends every running search of these clients with `engine_crashed` itself; here the
    // engines just go back to the pool.
    this.closeAllClients(false);

    const end = this.pendingEnd;
    this.pendingEnd = null;
    if (end) this.recordEnd(end.reason, end.message);
    else if (!this.localEnd) {
      this.recordEnd('socket_closed', `code ${code}${reason ? `: ${reason}` : ''}`);
    }
    this.log.info({ code, reason, welcomed }, 'link: closed');
    for (const w of this.closeWaiters.splice(0)) w();

    if (end && isFatalLinkEnd(end.reason)) {
      void this.fatal(end.reason, end.message);
      return;
    }
    if (this.stopping || this.draining) {
      this.state = 'stopped';
      this.resolveIdle();
      return;
    }
    // A link that stayed up for a while starts the backoff afresh; a flapping one keeps growing.
    if (welcomed && wasConnectedFor >= (this.opts.reconnectMaxMs ?? LINK_DEFAULTS.reconnectMaxMs)) {
      this.attempt = 0;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.draining || this.state === 'fatal') return;
    this.attempt++;
    const delay = reconnectDelayMs(this.attempt, this.random, {
      minMs: this.opts.reconnectMinMs ?? LINK_DEFAULTS.reconnectMinMs,
      maxMs: this.opts.reconnectMaxMs ?? LINK_DEFAULTS.reconnectMaxMs,
    });
    this.state = 'backoff';
    this.nextRetryAt = this.now() + delay;
    this.log.info({ attempt: this.attempt, delayMs: delay }, 'link: reconnecting after backoff');
    const t = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnects++;
      this.connect();
    }, delay);
    t.unref?.();
    this.reconnectTimer = t;
  }

  private async fatal(reason: NodeErrorCode | LinkCloseReason, message: string): Promise<void> {
    this.state = 'fatal';
    this.clearReconnectTimer();
    const hint = FATAL_HINTS[reason] ?? '';
    this.log.error(
      { reason, message },
      `link: the hub refused this node (${reason})${hint ? `: ${hint}` : ''}; exiting`,
    );
    await this.settleClosing();
    this.resolveIdle();
    const exit = this.opts.exit ?? ((code: number) => process.exit(code));
    await exit(1);
  }

  private async runDrain(reason: NodeDrainReason): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.draining = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    if (socket && this.welcome && socket.readyState === OPEN) {
      this.state = 'draining';
      this.sendFrame(socket, { type: 'node.drain', reason });
      const drainMs = Math.min(
        this.welcome.drainMs,
        this.opts.maxDrainMs ?? LINK_BOUNDS.drainMs.max,
      );
      this.log.info(
        { reason, drainMs, runningSearches: this.runningSearches(), clients: this.clients.size },
        'link: draining',
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.whenIdle(),
        new Promise<void>((r) => {
          timer = setTimeout(r, drainMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      const left = this.runningSearches();
      if (left > 0) this.log.warn({ runningSearches: left }, 'link: drain deadline passed');
    }
    await this.shutdown(1000, 'node drained');
  }

  /** Stops reconnecting, closes every client (acknowledging on an open link) and the socket. */
  private async shutdown(code: number, reason: string): Promise<void> {
    this.stopping = true;
    this.clearReconnectTimer();
    this.nextRetryAt = null;
    this.closeAllClients(true);
    await this.settleClosing();
    const socket = this.socket;
    if (socket) {
      const closed = new Promise<void>((r) => this.closeWaiters.push(r));
      try {
        socket.close(code, reason);
      } catch {
        socket.terminate();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        closed,
        new Promise<void>((r) => {
          timer = setTimeout(() => {
            if (this.socket === socket) socket.terminate();
            r();
          }, this.opts.closeTimeoutMs ?? 2_000);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      // terminate() emits 'close' asynchronously; do not wait for it beyond this point.
      if (this.socket === socket) {
        this.socket = null;
        this.clearLinkTimers();
        this.welcome = null;
      }
    }
    if (this.state !== 'fatal') this.state = 'stopped';
    this.resolveIdle();
  }

  // -------------------------------------------------------------------------------------------
  // Incoming frames

  private onFrame(socket: LinkSocket, data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      this.invalidFrame('binary frame');
      return;
    }
    const parsed = parseHubToNodeMessage(rawToString(data));
    if (!parsed.ok) {
      this.invalidFrame(parsed.error);
      return;
    }
    this.dispatch(socket, parsed.message);
  }

  private dispatch(socket: LinkSocket, msg: HubToNodeMessage): void {
    switch (msg.type) {
      case 'node.welcome':
        this.onWelcome(socket, msg);
        return;
      case 'node.error':
        this.endRequested(socket, msg.code, msg.message);
        return;
      case 'link.close':
        this.endRequested(socket, msg.reason, msg.message ?? `close ${msg.code}`);
        return;
      default:
        break;
    }
    if (!this.welcome) {
      this.invalidFrame(`${msg.type} before node.welcome`);
      return;
    }
    switch (msg.type) {
      case 'client.open':
        this.onClientOpen(socket, msg);
        return;
      case 'client.msg': {
        const client = this.clients.get(msg.cid);
        if (!client) {
          this.counters.unknownCid++;
          if (this.counters.unknownCid % 100 === 1) {
            this.log.warn(
              { cid: msg.cid, total: this.counters.unknownCid },
              'link: client.msg for an unknown cid ignored',
            );
          }
          return;
        }
        if (client.closing) return; // closing: the sessions ignore it anyway
        // Recorded before handle(): a rejection is delivered synchronously.
        client.tracker.in(msg.msg);
        client.sessions.handle(msg.msg);
        return;
      }
      case 'client.close': {
        const client = this.clients.get(msg.cid);
        if (!client) {
          // Idempotent: an unknown or already closed cid is acknowledged at once.
          this.sendFrame(socket, { type: 'client.closed', cid: msg.cid });
          return;
        }
        this.closeClient(client, true);
        return;
      }
    }
  }

  private onWelcome(socket: LinkSocket, msg: NodeWelcomeMessage): void {
    if (this.state !== 'handshaking') {
      this.invalidFrame('unexpected node.welcome');
      return;
    }
    if (msg.linkVersion !== LINK_PROTOCOL_VERSION) {
      this.endRequested(
        socket,
        'link_version',
        `hub speaks link protocol ${msg.linkVersion}, this node ${LINK_PROTOCOL_VERSION}`,
      );
      return;
    }
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    this.welcomeTimer = null;
    this.welcome = msg;
    this.connectedAt = this.now();
    this.lastPongAt = this.connectedAt;
    this.awaitingPongs = 0;
    this.nextRetryAt = null;
    this.state = this.draining ? 'draining' : 'connected';
    this.log.info(
      {
        nodeId: msg.nodeId,
        name: msg.name,
        hubVersion: msg.hubVersion,
        pool: msg.pool,
        heartbeatMs: msg.heartbeatMs,
        drainMs: msg.drainMs,
      },
      'link: registered with the hub',
    );
    this.logVersionStatus(msg);
    const hb = setInterval(() => this.heartbeat(socket), msg.heartbeatMs);
    hb.unref?.();
    this.heartbeatTimer = hb;
    this.sendStatus();
  }

  private logVersionStatus(msg: NodeWelcomeMessage): void {
    const status = nodeVersionStatus(this.opts.version, msg);
    if (status === 'outdated') {
      this.log.warn(
        { version: this.opts.version, minNodeVersion: msg.minNodeVersion },
        'link: this node is below the hub minimum and will be refused soon; please update',
      );
    } else if (status === 'update_available') {
      const now = this.now();
      if (this.lastUpdateNoticeAt === null || now - this.lastUpdateNoticeAt >= DAY_MS) {
        this.lastUpdateNoticeAt = now;
        this.log.info(
          { version: this.opts.version, latestNodeVersion: msg.latestNodeVersion },
          'link: a newer node is available',
        );
      }
    }
  }

  /** `node.error` / `link.close`: remember why, then close (the hub closes too). */
  private endRequested(
    socket: LinkSocket,
    reason: NodeErrorCode | LinkCloseReason,
    message: string,
  ): void {
    this.pendingEnd = { reason, message };
    const fatal = isFatalLinkEnd(reason);
    (fatal ? this.log.error : this.log.warn).call(
      this.log,
      { reason, message },
      fatal ? 'link: fatal end announced by the hub' : 'link: hub ends the link',
    );
    try {
      socket.close(1000, reason);
    } catch {
      socket.terminate();
    }
  }

  private invalidFrame(error: string): void {
    this.counters.invalidFrames++;
    if (this.counters.invalidFrames % 100 === 1) {
      this.log.warn(
        { error: error.slice(0, 200), total: this.counters.invalidFrames },
        'link: invalid frame from the hub ignored',
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // Clients

  private onClientOpen(socket: LinkSocket, msg: ClientOpenMessage): void {
    const { cid } = msg;
    if (this.draining || this.stopping) {
      this.counters.rejectedClients++;
      this.sendFrame(socket, { type: 'client.closed', cid });
      return;
    }
    if (this.clients.has(cid)) {
      this.invalidFrame(`client.open for an open cid ${cid}`);
      return;
    }
    if (this.clients.size >= this.maxClients) {
      this.counters.rejectedClients++;
      this.log.warn({ cid, clients: this.clients.size }, 'link: too many clients; refusing');
      this.sendFrame(socket, { type: 'client.closed', cid });
      return;
    }
    // Defence in depth (ADR-020 §5): the hub can narrow this node's limits, never widen them.
    const limits = minLimits(msg.limits, this.opts.limits);
    // `ref.client` is set before ClientSessions can deliver anything (only handle() does).
    const ref: { client?: LinkClient } = {};
    const sessions = new ClientSessions(
      this.deliverFor(() => ref.client!),
      { ip: cid, id: cid },
      {
        backend: this.backend,
        limits,
        engines: clampEngines(this.opts.engines, limits),
        logger: this.log,
        ledger: this.ledger,
        sessionIdleMs: this.opts.sessionIdleMs,
        ...(this.opts.stopTimeoutMs !== undefined
          ? { stopTimeoutMs: this.opts.stopTimeoutMs }
          : {}),
        ...(this.opts.analyzeRateLimit ? { analyzeRateLimit: this.opts.analyzeRateLimit } : {}),
      },
    );
    const client: LinkClient = {
      cid,
      socket,
      sessions,
      closing: null,
      tracker: new SessionTracker(this.now),
      infoWindows: new Map(),
    };
    ref.client = client;
    this.clients.set(cid, client);
    this.log.info(
      { cid, shared: msg.shared, tier: msg.tier, ...(msg.tokenId ? { tokenId: msg.tokenId } : {}) },
      'link: client opened',
    );
  }

  /** Closes one client's sessions; acknowledges with `client.closed` on the same, open link. */
  private closeClient(client: LinkClient, ack: boolean): void {
    if (client.closing) return;
    const p = client.sessions.close().then(() => {
      if (this.clients.get(client.cid) === client) this.clients.delete(client.cid);
      if (ack && this.socket === client.socket && client.socket.readyState === OPEN) {
        this.sendFrame(client.socket, { type: 'client.closed', cid: client.cid });
      }
      this.log.debug({ cid: client.cid }, 'link: client closed');
      this.resolveIdle();
    });
    client.closing = p;
    this.closingClients.add(p);
    void p.finally(() => this.closingClients.delete(p));
    this.resolveIdle();
  }

  private closeAllClients(ack: boolean): void {
    for (const client of [...this.clients.values()]) this.closeClient(client, ack);
    if (!ack) this.clients.clear(); // a new link may reuse cids while these still close
  }

  private async settleClosing(): Promise<void> {
    while (this.closingClients.size > 0) {
      await Promise.allSettled([...this.closingClients]);
    }
  }

  private deliverFor(getClient: () => LinkClient): Deliver {
    return (msg: AnalysisServerMessage) => {
      const client = getClient();
      if (client.closing) return;
      if (msg.type === 'error' && msg.sessionId === undefined) {
        // Not representable on the link (and never produced by ClientSessions): log, drop.
        this.log.warn({ cid: client.cid, code: msg.code }, 'link: connection-level error dropped');
        return;
      }
      if (msg.type === 'info') {
        if (!this.allowInfo(client, msg)) return;
      } else {
        // Terminal or session-level message: never dropped while the link is open.
        for (const ev of client.tracker.out(msg)) {
          if (ev.kind === 'search_ended') this.searchEnded(client, ev.sessionId, ev.searchId);
        }
      }
      this.sendFrame(client.socket, { type: 'client.msg', cid: client.cid, msg });
    };
  }

  private allowInfo(client: LinkClient, msg: AnalysisServerMessage & { type: 'info' }): boolean {
    const socket = client.socket;
    if (socket.readyState !== OPEN) return false;
    if (socket.bufferedAmount > this.maxBufferedBytes) {
      if (this.counters.droppedInfoBackpressure++ % 1_000 === 0) {
        this.log.debug(
          { cid: client.cid, dropped: this.counters.droppedInfoBackpressure },
          'link backpressure: dropping info',
        );
      }
      return false;
    }
    // The final info carrying the policy distribution (ADR-019) is part of the result.
    if (msg.info.policy !== undefined) return true;
    const now = this.now();
    let w = client.infoWindows.get(msg.sessionId);
    if (!w || w.searchId !== msg.searchId || now - w.windowStart >= 1_000) {
      w = { searchId: msg.searchId, windowStart: now, count: 0 };
      client.infoWindows.set(msg.sessionId, w);
    }
    if (w.count >= this.infoPerSecond) {
      this.counters.droppedInfoRate++;
      return false;
    }
    w.count++;
    return true;
  }

  private searchEnded(client: LinkClient, sessionId: string, searchId: number): void {
    const w = client.infoWindows.get(sessionId);
    if (w && w.searchId === searchId) client.infoWindows.delete(sessionId);
    this.resolveIdle();
  }

  private runningSearches(): number {
    let n = 0;
    for (const c of this.clients.values()) {
      if (!c.closing) n += c.tracker.openSearchCount;
    }
    return n;
  }

  private whenIdle(): Promise<void> {
    if (this.runningSearches() === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private resolveIdle(): void {
    if (this.idleWaiters.length === 0) return;
    if (this.runningSearches() > 0 && this.socket !== null) return;
    for (const w of this.idleWaiters.splice(0)) w();
  }

  // -------------------------------------------------------------------------------------------
  // Heartbeat and status

  private heartbeat(socket: LinkSocket): void {
    if (socket !== this.socket || socket.readyState !== OPEN) return;
    if (this.awaitingPongs >= LINK_DEFAULTS.missedPongsToDrop) {
      this.log.warn({ missed: this.awaitingPongs }, 'link: hub stopped answering pings; dropping');
      this.pendingEnd = null;
      this.recordEnd('heartbeat', `${this.awaitingPongs} pings unanswered`);
      this.localEnd = true;
      this.clearLinkTimers();
      socket.terminate();
      return;
    }
    this.awaitingPongs++;
    try {
      socket.ping();
    } catch {
      // closing; the close handler takes over
    }
    this.sendStatus();
  }

  /** Sends `node.status` (once per tick) when the pool's session count changed since the last. */
  private queueStatus(): void {
    if (this.statusQueued) return;
    this.statusQueued = true;
    queueMicrotask(() => {
      this.statusQueued = false;
      if (this.leases.size !== this.lastStatusSessions) this.sendStatus();
    });
  }

  private sendStatus(): void {
    const socket = this.socket;
    if (!socket || !this.welcome || socket.readyState !== OPEN) return;
    const load = this.opts.load1?.() ?? os.loadavg()[0] ?? 0;
    const sessions = this.leases.size;
    this.lastStatusSessions = sessions;
    this.sendFrame(socket, {
      type: 'node.status',
      sessions: Math.min(Math.max(sessions, 0), LINK_BOUNDS.maxSessions.max),
      maxSessions: this.opts.maxSessions,
      load1: Number.isFinite(load) ? Math.min(Math.max(load, 0), 100_000) : 0,
      engines: this.opts.engineStatus().slice(0, LINK_BOUNDS.maxEngines),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Outgoing

  /** Validates (`client.msg`), serialises and sends one frame; false when it was not sent. */
  private sendFrame(socket: LinkSocket, msg: NodeToHubMessage): boolean {
    if (socket.readyState !== OPEN) return false;
    let frame: NodeToHubMessage = msg;
    if (msg.type === 'client.msg') {
      const check = ClientMsgFromNodeSchema.safeParse(msg);
      if (!check.success) {
        this.log.warn(
          { cid: msg.cid, type: msg.msg.type, issues: check.error.issues.slice(0, 3) },
          'link: dropping invalid outgoing message',
        );
        return false;
      }
      frame = check.data;
    }
    const out = serializeLinkMessage(frame);
    if (!out.ok) {
      this.log.error({ error: out.error }, 'link: outgoing frame too large; dropped');
      return false;
    }
    try {
      socket.send(out.text);
      return true;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'link: send failed');
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------

  private recordEnd(reason: LinkEnd['reason'], message: string): void {
    this.lastEnd = {
      reason,
      message: message.slice(0, 300),
      at: new Date(this.now()).toISOString(),
    };
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearLinkTimers(): void {
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    this.welcomeTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

function rawToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/** The hub URL without query/fragment (never contains secrets, but keep logs tidy). */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}
