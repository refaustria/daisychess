import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import {
  LINK_DEFAULTS,
  LINK_PROTOCOL_VERSION,
  MAX_LINK_MESSAGE_BYTES,
  checkLinkCompatibility,
  parseNodeToHubMessage,
  serializeLinkMessage,
  type HubToNodeMessage,
  type LinkCloseReason,
  type NodeErrorCode,
  type NodeHelloMessage,
  type NodeToHubMessage,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import { allowRate, type RateLimit } from '../sessions/rateLimit.js';
import { resolveClientIp, type TrustedProxies } from '../ws/clientIp.js';
import { HubNodeLink, type HubNodeLinkOptions } from './HubNodeLink.js';
import type { NodeRegistry } from './NodeRegistry.js';
import type { NodeVerifyResult } from './tokens.js';

/** Verifies `node.hello.nodeToken` (`HubTokenService` satisfies it). */
export interface NodeAuthenticator {
  verifyNodeToken(raw: unknown, now?: number): NodeVerifyResult;
}

/** Records signs of life of a node (`HubStore` satisfies it; throttled there). */
export interface NodeSeenSink {
  markNodeSeen(id: string, now: number, info?: { version?: string; maxSessions?: number }): boolean;
}

/**
 * WebSocket close codes the hub uses on `/link`. A refused handshake (`node.error`) closes 1008
 * (policy violation; M24-15's fail2ban filter counts those). `link.close` names its own code.
 */
export const LINK_CLOSE_CODES: Readonly<Record<LinkCloseReason, number>> & { nodeError: number } = {
  nodeError: 1008,
  revoked: 4403,
  replaced: 4409,
  rate_limited: 4429,
  shutdown: 1012,
};

export interface LinkServerOptions {
  auth: NodeAuthenticator;
  /** Optional `last_seen_at`/version bookkeeping (HubStore). */
  seen?: NodeSeenSink;
  registry: NodeRegistry;
  logger: PoolLogger;
  /** `node.welcome.hubVersion`. */
  hubVersion: string;
  /** `NODE_MIN_VERSION`: older nodes are refused with `node_outdated`. */
  minNodeVersion: string;
  /** `node.welcome.latestNodeVersion`. */
  latestNodeVersion: string;
  /** URL path. Default `/link`. */
  path?: string;
  /** `node.welcome.heartbeatMs` (the node's `node.status` cadence). Default 10 s. */
  heartbeatMs?: number;
  /** `node.welcome.drainMs`. Default 30 s. */
  drainMs?: number;
  /** The hub's WebSocket ping cadence. Default `heartbeatMs`. */
  pingIntervalMs?: number;
  /** Unanswered pings after which the link is dropped. Default 2. */
  missedPongsToDrop?: number;
  /** A link without a valid `node.hello` is closed after this long. Default 10 s. */
  helloTimeoutMs?: number;
  /** Concurrent `/link` sockets per client address (handshaking or registered). Default 5. */
  maxPerIp?: number;
  /** Frames per second accepted from one link; above it `link.close rate_limited`. Default 5 000. */
  maxMessagesPerSecond?: number;
  /** Invalid frames tolerated per window; above it `link.close rate_limited`. Default 100/min. */
  invalidFrameLimit?: RateLimit;
  /** Frames for unknown `cid`s tolerated per window. Default 100/min. */
  unknownCidLimit?: RateLimit;
  /** Peers whose `X-Real-IP` is trusted (nginx). */
  trustedProxies?: TrustedProxies;
  /** How long a closing link may take before it is terminated. Default 2 s. */
  closeTimeoutMs?: number;
  /** Tuning of every relay. */
  relay?: HubNodeLinkOptions['relay'];
  now?: () => number;
}

export interface LinkNodeStats {
  nodeId: string;
  name: string;
  state: 'online' | 'draining';
  pool: boolean;
  poolShare: number;
  version: string;
  platform: string;
  arch: string;
  engines: string[];
  maxSessions: number;
  sessions: number | null;
  load1: number | null;
  clients: number;
  connectedSince: string;
  rttMs: number | null;
  unknownCid: number;
}

/** `/health/detail.nodes`: contains no token, secret or address. */
export interface LinkServerStats {
  sockets: number;
  handshaking: number;
  nodes: LinkNodeStats[];
  counters: {
    accepted: number;
    refused: Record<string, number>;
    rejectedPerIp: number;
    replaced: number;
    rateLimited: number;
    heartbeatDrops: number;
    invalidFrames: number;
  };
}

type ConnState = 'hello' | 'open' | 'closing' | 'closed';

interface LinkConn {
  readonly ws: WebSocket;
  readonly ip: string;
  state: ConnState;
  nodeId: string | null;
  hub: HubNodeLink | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  frameWindowStart: number;
  frameCount: number;
  readonly invalidTimes: number[];
  awaitingPongs: number;
  pingSentAt: number | null;
  readonly closed: Promise<void>;
  resolveClosed: () => void;
}

/**
 * The hub's `/link` endpoint (ADR-020 §3, relay layering §6). Nodes connect outbound; the first
 * frame must be a valid `node.hello` within `helloTimeoutMs`, checked for link/node version
 * (`checkLinkCompatibility`, `NODE_MIN_VERSION`) and node token (`verifyNodeToken`); a refusal is
 * answered with `node.error` and close 1008. An accepted node gets `node.welcome`, a
 * {@link HubNodeLink} and an entry in the {@link NodeRegistry}. A second link for the same node id
 * wins: the older one gets `link.close replaced` and its relays end with `engine_crashed`.
 *
 * Nodes are not browsers: there is no Origin check; the node token is the authentication.
 * Limits: concurrent sockets per address, `maxPayload` = {@link MAX_LINK_MESSAGE_BYTES} (a bigger
 * frame closes the link 1009), frames per second, invalid frames and unknown-`cid` frames per
 * minute (`link.close rate_limited`), ping/pong with `missedPongsToDrop`.
 */
export class LinkServer {
  readonly path: string;
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<LinkConn>();
  private readonly byNode = new Map<string, LinkConn>();
  private readonly perIp = new Map<string, number>();
  private readonly pingTimer: ReturnType<typeof setInterval>;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly log: PoolLogger;
  private readonly heartbeatMs: number;
  private readonly drainMs: number;
  private readonly missedPongs: number;
  private readonly helloTimeoutMs: number;
  private readonly maxPerIp: number;
  private readonly maxPerSecond: number;
  private readonly invalidLimit: RateLimit;
  private readonly closeTimeoutMs: number;
  private readonly counters = {
    accepted: 0,
    refused: {} as Record<string, number>,
    rejectedPerIp: 0,
    replaced: 0,
    rateLimited: 0,
    heartbeatDrops: 0,
    invalidFrames: 0,
  };

  constructor(private readonly opts: LinkServerOptions) {
    this.path = opts.path ?? '/link';
    this.now = opts.now ?? Date.now;
    this.log = opts.logger;
    this.heartbeatMs = opts.heartbeatMs ?? LINK_DEFAULTS.heartbeatMs;
    this.drainMs = opts.drainMs ?? LINK_DEFAULTS.drainMs;
    this.missedPongs = opts.missedPongsToDrop ?? LINK_DEFAULTS.missedPongsToDrop;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? LINK_DEFAULTS.helloTimeoutMs;
    this.maxPerIp = opts.maxPerIp ?? 5;
    this.maxPerSecond = opts.maxMessagesPerSecond ?? LINK_DEFAULTS.maxMessagesPerSecond;
    this.invalidLimit = opts.invalidFrameLimit ?? { max: 100, windowMs: 60_000 };
    this.closeTimeoutMs = opts.closeTimeoutMs ?? 2_000;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_LINK_MESSAGE_BYTES,
      perMessageDeflate: false,
      clientTracking: false,
    });
    this.pingTimer = setInterval(() => this.heartbeat(), opts.pingIntervalMs ?? this.heartbeatMs);
    this.pingTimer.unref();
  }

  /** Handles an HTTP upgrade routed to {@link path} (from the Fastify server's `upgrade`). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      reject(socket, '400 Bad Request');
      return;
    }
    if (pathname !== this.path) {
      reject(socket, '404 Not Found');
      return;
    }
    if (this.closing) {
      reject(socket, '503 Service Unavailable');
      return;
    }
    const ip = resolveClientIp(
      req.socket.remoteAddress,
      req.headers['x-real-ip'],
      this.opts.trustedProxies ?? [],
    );
    const held = this.perIp.get(ip) ?? 0;
    if (held >= this.maxPerIp) {
      this.counters.rejectedPerIp++;
      this.log.warn({ ip, held }, 'link: too many links from this address; rejecting');
      reject(socket, '429 Too Many Requests');
      return;
    }
    // Counted until the TCP socket closes, whether or not the upgrade completes.
    this.perIp.set(ip, held + 1);
    let released = false;
    socket.once('close', () => {
      if (released) return;
      released = true;
      const n = (this.perIp.get(ip) ?? 1) - 1;
      if (n <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, n);
    });
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
  }

  /** Closes a node's link (portal revoke, M24-9). False when the node is not connected. */
  closeNode(nodeId: string, reason: LinkCloseReason, message?: string): boolean {
    const conn = this.byNode.get(nodeId);
    if (!conn || conn.state !== 'open') return false;
    this.endLink(conn, reason, message ?? reason);
    return true;
  }

  /**
   * Ends the node's **shared** (pool) player connections the same way a node loss does — one
   * terminal per open search, then the hub closes those sockets with 1012 and the players
   * reconnect to another pool node — while private connections stay (M24-12: suspect / pool
   * ban). Returns how many were ended (0 when the node is not connected).
   */
  evictShared(nodeId: string, message: string): number {
    const conn = this.byNode.get(nodeId);
    if (!conn || conn.state !== 'open' || !conn.hub) return 0;
    return conn.hub.evictShared(message);
  }

  stats(): LinkServerStats {
    const iso = (t: number) => new Date(t).toISOString();
    let handshaking = 0;
    for (const c of this.conns) if (c.state === 'hello') handshaking++;
    return {
      sockets: this.conns.size,
      handshaking,
      nodes: this.opts.registry.online().map((n) => ({
        nodeId: n.nodeId,
        name: n.name,
        state: n.state,
        pool: n.pool,
        poolShare: n.poolShare,
        version: n.version,
        platform: n.platform,
        arch: n.arch,
        engines: n.engines.map((e) => e.id),
        maxSessions: n.maxSessions,
        sessions: n.status?.sessions ?? null,
        load1: n.status?.load1 ?? null,
        clients: n.link.clients,
        connectedSince: iso(n.connectedAt),
        rttMs: n.rttMs,
        unknownCid: n.link.stats().unknownCid,
      })),
      counters: { ...this.counters, refused: { ...this.counters.refused } },
    };
  }

  /**
   * Shutdown: refuses new links, sends `link.close shutdown` (1012) to every node so it
   * reconnects with backoff, ends every relay, waits for the sockets (≤ `closeTimeoutMs`).
   */
  close(): Promise<void> {
    this.closePromise ??= this.runClose();
    return this.closePromise;
  }

  // -------------------------------------------------------------------------------------------

  private async runClose(): Promise<void> {
    this.closing = true;
    clearInterval(this.pingTimer);
    const all = [...this.conns];
    for (const conn of all) {
      if (conn.state === 'open') this.endLink(conn, 'shutdown', 'hub shutting down');
      else if (conn.state === 'hello') this.closeConn(conn, 1001, 'hub shutting down');
    }
    await Promise.allSettled(all.map((c) => c.closed));
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  private onConnection(ws: WebSocket, ip: string): void {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => (resolveClosed = r));
    const conn: LinkConn = {
      ws,
      ip,
      state: 'hello',
      nodeId: null,
      hub: null,
      helloTimer: null,
      closeTimer: null,
      frameWindowStart: this.now(),
      frameCount: 0,
      invalidTimes: [],
      awaitingPongs: 0,
      pingSentAt: null,
      closed,
      resolveClosed,
    };
    this.conns.add(conn);
    const t = setTimeout(() => {
      conn.helloTimer = null;
      if (conn.state !== 'hello') return;
      this.refuse(conn, 'invalid_message', `no node.hello within ${this.helloTimeoutMs} ms`);
    }, this.helloTimeoutMs);
    t.unref?.();
    conn.helloTimer = t;

    ws.on('message', (data, isBinary) => this.onFrame(conn, data, isBinary));
    ws.on('pong', () => {
      conn.awaitingPongs = 0;
      if (conn.pingSentAt !== null && conn.nodeId && conn.hub) {
        this.opts.registry.setRtt(conn.nodeId, conn.hub, this.now() - conn.pingSentAt);
      }
      conn.pingSentAt = null;
    });
    ws.on('error', (err) => {
      // e.g. a frame above maxPayload (ws closes 1009 itself) or an invalid frame.
      this.log.warn({ node: conn.nodeId, ip, err: err.message }, 'link: socket error');
    });
    ws.on('close', (code, reason) => this.onClose(conn, code, reason.toString()));
    if (this.closing) this.closeConn(conn, 1001, 'hub shutting down');
  }

  private onClose(conn: LinkConn, code: number, reason: string): void {
    if (conn.state === 'closed') return;
    const wasOpen = conn.hub !== null;
    this.detach(conn);
    conn.state = 'closed';
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    if (conn.closeTimer) clearTimeout(conn.closeTimer);
    conn.helloTimer = null;
    conn.closeTimer = null;
    this.conns.delete(conn);
    if (wasOpen) {
      this.log.info(
        { node: conn.nodeId, code, reason: reason.slice(0, 120) },
        'link: node offline',
      );
    }
    conn.resolveClosed();
  }

  /** Removes a registered link from the registry and ends its relays (idempotent). */
  private detach(conn: LinkConn): void {
    const hub = conn.hub;
    const nodeId = conn.nodeId;
    if (!hub || !nodeId) return;
    conn.hub = null;
    if (this.byNode.get(nodeId) === conn) this.byNode.delete(nodeId);
    this.opts.registry.unregister(nodeId, hub);
    hub.lost();
  }

  // -------------------------------------------------------------------------------------------
  // Frames

  private onFrame(conn: LinkConn, data: RawData, isBinary: boolean): void {
    if (conn.state !== 'hello' && conn.state !== 'open') return;
    if (!this.allowFrame(conn)) return;
    if (isBinary) {
      this.invalid(conn, 'binary frame');
      return;
    }
    const parsed = parseNodeToHubMessage(rawToString(data));
    if (conn.state === 'hello') {
      if (!parsed.ok || parsed.message.type !== 'node.hello') {
        this.refuse(
          conn,
          'invalid_message',
          parsed.ok
            ? `expected node.hello, got ${parsed.message.type}`
            : parsed.error.slice(0, 300),
        );
        return;
      }
      this.onHello(conn, parsed.message);
      return;
    }
    if (!parsed.ok) {
      this.invalid(conn, parsed.error);
      return;
    }
    this.dispatch(conn, parsed.message);
  }

  private dispatch(conn: LinkConn, msg: NodeToHubMessage): void {
    const hub = conn.hub;
    const nodeId = conn.nodeId;
    if (!hub || !nodeId) return;
    switch (msg.type) {
      case 'node.hello':
        this.invalid(conn, 'node.hello after node.welcome');
        return;
      case 'node.status':
        this.opts.registry.updateStatus(nodeId, hub, msg, this.now());
        this.markSeen(nodeId, { maxSessions: msg.maxSessions });
        return;
      case 'node.drain':
        this.log.info({ node: nodeId, reason: msg.reason }, 'link: node draining');
        this.opts.registry.setDraining(nodeId, hub, msg.reason);
        return;
      case 'client.msg':
      case 'client.closed':
        hub.onFrame(msg);
        return;
    }
  }

  private onHello(conn: LinkConn, hello: NodeHelloMessage): void {
    const compat = checkLinkCompatibility(hello, { minNodeVersion: this.opts.minNodeVersion });
    if (!compat.ok) {
      this.refuse(conn, compat.code, compat.message);
      return;
    }
    const now = this.now();
    let verified: NodeVerifyResult;
    try {
      verified = this.opts.auth.verifyNodeToken(hello.nodeToken, now);
    } catch (err) {
      this.log.error({ ip: conn.ip, err: (err as Error).message }, 'link: token check failed');
      this.closeConn(conn, 1011, 'internal error');
      return;
    }
    if ('error' in verified) {
      const revoked = verified.error === 'revoked';
      this.refuse(
        conn,
        revoked ? 'revoked' : 'bad_token',
        revoked ? 'this node was revoked' : 'node token not accepted',
      );
      return;
    }
    const record = verified.record;
    const previous = this.byNode.get(record.id);
    if (previous && previous !== conn) {
      this.counters.replaced++;
      this.log.warn(
        { node: record.id, ip: conn.ip },
        'link: node connected again; the older link is replaced',
      );
      this.endLink(previous, 'replaced', 'another link connected with this node token');
    }
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    const hub = new HubNodeLink({
      nodeId: record.id,
      send: (m) => this.send(conn, m),
      logger: this.log,
      onAbuse: (reason, message) => {
        this.log.warn({ node: record.id, message }, 'link: node exceeded the unknown-cid limit');
        this.endLink(conn, reason, message);
      },
      now: this.now,
      ...(this.opts.unknownCidLimit ? { unknownCidLimit: this.opts.unknownCidLimit } : {}),
      ...(this.opts.relay ? { relay: this.opts.relay } : {}),
    });
    conn.state = 'open';
    conn.nodeId = record.id;
    conn.hub = hub;
    this.byNode.set(record.id, conn);
    // A pool ban (M24-12) keeps the link and private tokens, never the pool.
    const pool =
      hello.pool && record.pool && record.state === 'normal' && record.poolBannedAt === null;
    const sent = this.send(conn, {
      type: 'node.welcome',
      linkVersion: LINK_PROTOCOL_VERSION,
      hubVersion: this.opts.hubVersion,
      nodeId: record.id,
      name: record.name,
      pool,
      heartbeatMs: this.heartbeatMs,
      drainMs: this.drainMs,
      minNodeVersion: this.opts.minNodeVersion,
      latestNodeVersion: this.opts.latestNodeVersion,
    });
    if (!sent) {
      this.detach(conn);
      this.closeConn(conn, 1011, 'internal error');
      return;
    }
    this.counters.accepted++;
    this.opts.registry.register({
      nodeId: record.id,
      name: record.name,
      operatorId: record.operatorId,
      version: hello.node.version,
      platform: hello.node.platform,
      arch: hello.node.arch,
      engines: hello.engines,
      limits: hello.limits,
      maxSessions: hello.maxSessions,
      pool,
      nodePool: hello.pool,
      poolShare: record.poolShare,
      connectedAt: now,
      link: hub,
    });
    this.markSeen(record.id, { version: hello.node.version, maxSessions: hello.maxSessions });
    this.log.info(
      {
        node: record.id,
        name: record.name,
        version: hello.node.version,
        platform: hello.node.platform,
        arch: hello.node.arch,
        engines: hello.engines.length,
        maxSessions: hello.maxSessions,
        pool,
        ip: conn.ip,
      },
      'link: node online',
    );
  }

  // -------------------------------------------------------------------------------------------
  // Limits and heartbeat

  private allowFrame(conn: LinkConn): boolean {
    const now = this.now();
    if (now - conn.frameWindowStart >= 1_000) {
      conn.frameWindowStart = now;
      conn.frameCount = 0;
    }
    conn.frameCount++;
    if (conn.frameCount <= this.maxPerSecond) return true;
    this.counters.rateLimited++;
    const message = `more than ${this.maxPerSecond} frames per second`;
    this.log.warn({ node: conn.nodeId, ip: conn.ip }, `link: ${message}; closing`);
    if (conn.state === 'open') this.endLink(conn, 'rate_limited', message);
    else this.refuse(conn, 'rate_limited', message);
    return false;
  }

  private invalid(conn: LinkConn, error: string): void {
    this.counters.invalidFrames++;
    if (this.counters.invalidFrames % 100 === 1) {
      this.log.warn(
        { node: conn.nodeId, error: error.slice(0, 200), total: this.counters.invalidFrames },
        'link: invalid frame from a node ignored',
      );
    }
    if (!allowRate(conn.invalidTimes, this.invalidLimit, this.now())) {
      this.counters.rateLimited++;
      this.endLink(conn, 'rate_limited', 'too many invalid frames');
    }
  }

  private heartbeat(): void {
    for (const conn of this.conns) {
      if (conn.state !== 'open') continue;
      if (conn.awaitingPongs >= this.missedPongs) {
        this.counters.heartbeatDrops++;
        this.log.warn(
          { node: conn.nodeId, missed: conn.awaitingPongs },
          'link: node stopped answering pings; dropping',
        );
        this.detach(conn);
        conn.state = 'closing';
        conn.ws.terminate();
        continue;
      }
      conn.awaitingPongs++;
      conn.pingSentAt = this.now();
      try {
        conn.ws.ping();
      } catch {
        // closing; the close handler takes over
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Ending links

  /** Handshake refused: `node.error {code}` then close 1008. */
  private refuse(conn: LinkConn, code: NodeErrorCode, message: string): void {
    if (conn.state !== 'hello') return;
    this.counters.refused[code] = (this.counters.refused[code] ?? 0) + 1;
    this.log.warn({ ip: conn.ip, code, message: message.slice(0, 200) }, 'link: node refused');
    this.send(conn, { type: 'node.error', code, message: message.slice(0, 1_000) });
    this.closeConn(conn, LINK_CLOSE_CODES.nodeError, code);
  }

  /** An established link ends: `link.close {reason, code}`, relays end now, then the socket. */
  private endLink(conn: LinkConn, reason: LinkCloseReason, message: string): void {
    if (conn.state !== 'open') return;
    const code = LINK_CLOSE_CODES[reason];
    this.send(conn, { type: 'link.close', reason, code, message: message.slice(0, 1_000) });
    this.detach(conn);
    this.closeConn(conn, code, reason);
  }

  private closeConn(conn: LinkConn, code: number, reason: string): void {
    if (conn.state === 'closing' || conn.state === 'closed') return;
    conn.state = 'closing';
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
    const t = setTimeout(() => {
      conn.closeTimer = null;
      conn.ws.terminate();
    }, this.closeTimeoutMs);
    t.unref?.();
    conn.closeTimer = t;
  }

  private send(conn: LinkConn, msg: HubToNodeMessage): boolean {
    if (conn.ws.readyState !== WebSocket.OPEN) return false;
    const out = serializeLinkMessage(msg);
    if (!out.ok) {
      this.log.error({ node: conn.nodeId, error: out.error }, 'link: outgoing frame too large');
      return false;
    }
    try {
      conn.ws.send(out.text);
      return true;
    } catch (err) {
      this.log.warn({ node: conn.nodeId, err: (err as Error).message }, 'link: send failed');
      return false;
    }
  }

  private markSeen(nodeId: string, info: { version?: string; maxSessions?: number }): void {
    if (!this.opts.seen) return;
    try {
      this.opts.seen.markNodeSeen(nodeId, this.now(), info);
    } catch (err) {
      this.log.warn({ node: nodeId, err: (err as Error).message }, 'link: markNodeSeen failed');
    }
  }
}

function reject(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
