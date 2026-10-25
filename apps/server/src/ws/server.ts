import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import { MAX_LARGE_MESSAGE_BYTES } from '@daisychess/engine-core';
import { Connection, type ConnectionOptions } from './connection.js';
import { isOriginAllowed, type OriginPolicy } from './origin.js';
import { IpSessionLedger, resolveClientIp, type TrustedProxies } from './clientIp.js';
import { RoomManager, type RoomConfig, type RoomManagerOptions } from '../rooms/RoomManager.js';
import { ReviewService } from '../review/ReviewService.js';
import type { ReviewStore } from '../review/ReviewStore.js';

export interface WsServerOptions extends Omit<ConnectionOptions, 'rooms' | 'review'> {
  /** Room policy (ADR-013). */
  roomConfig: RoomConfig;
  /** Review store (ADR-017); null when disabled or it failed to open. Closed with the server. */
  reviewStore: ReviewStore | null;
  /** Review writes per client address per day. */
  reviewPutPerIpPerDay: number;
  /** Room manager tuning for tests (clock, id generators). */
  roomManager?: Omit<RoomManagerOptions, 'config' | 'logger'>;
  /** URL path that accepts upgrades. Default `/ws`. */
  path?: string;
  /** Interval of WebSocket pings; a connection that missed one pong is terminated. Default 30 s. */
  heartbeatMs?: number;
  /** Browser `Origin` policy (ADR-008). Default: same host as the request. */
  allowedOrigins?: OriginPolicy;
  /** Concurrently leased engine sessions per client address. Default: unlimited. */
  maxSessionsPerIp?: number;
  /** Peers besides loopback whose `X-Real-IP` is trusted. Default: none. */
  trustedProxies?: TrustedProxies;
}

export interface WsServerHandle {
  readonly connections: ReadonlySet<Connection>;
  /** Engine sessions per client address. */
  readonly ipSessions: IpSessionLedger;
  /** "Play a friend" rooms (ADR-013). */
  readonly rooms: RoomManager;
  /** Review store service (ADR-017). */
  readonly review: ReviewService;
  /** Closes every connection (1001), waits until their sessions are released, closes the server. */
  close(): Promise<void>;
}

/**
 * Attaches a raw `ws` server to Fastify's HTTP server (`noServer` + `upgrade`), so the WebSocket
 * endpoint shares the port with `/health` and needs no Fastify plugin.
 */
export function attachWebSocketServer(app: FastifyInstance, opts: WsServerOptions): WsServerHandle {
  const path = opts.path ?? '/ws';
  const wss = new WebSocketServer({
    noServer: true,
    // Record-carrying review frames may be this large; every other type is limited by
    // `parseClientMessage` to MAX_MESSAGE_BYTES.
    maxPayload: MAX_LARGE_MESSAGE_BYTES,
    perMessageDeflate: false,
    clientTracking: false,
  });
  const connections = new Set<Connection>();
  const ledger = new IpSessionLedger(opts.maxSessionsPerIp ?? Number.POSITIVE_INFINITY);
  const rooms = new RoomManager({
    ...opts.roomManager,
    config: opts.roomConfig,
    logger: opts.logger,
  });
  const review = new ReviewService({
    store: opts.reviewStore,
    putPerIpPerDay: opts.reviewPutPerIpPerDay,
    logger: opts.logger,
  });
  const connOpts: ConnectionOptions = { ...opts, rooms, review };
  let closing = false;

  const reject = (socket: Duplex, status: string) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      reject(socket, '400 Bad Request');
      return;
    }
    if (pathname !== path) {
      reject(socket, '404 Not Found');
      return;
    }
    if (closing) {
      reject(socket, '503 Service Unavailable');
      return;
    }
    const origin = headerValue(req.headers.origin);
    if (!isOriginAllowed(origin, req.headers.host, opts.allowedOrigins ?? null)) {
      opts.logger.warn(
        { origin: origin?.slice(0, 200), host: req.headers.host?.slice(0, 200) },
        'rejecting websocket upgrade: origin not allowed',
      );
      reject(socket, '403 Forbidden');
      return;
    }
    // nginx forwards the client address in X-Real-IP; trusted only from a proxy peer.
    const ip = resolveClientIp(
      req.socket.remoteAddress,
      req.headers['x-real-ip'],
      opts.trustedProxies ?? [],
    );
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new Connection(ws, connOpts, { ip, ledger });
      connections.add(conn);
      opts.logger.info({ conn: conn.id, ip }, 'websocket connected');
      void conn.whenClosed().then(() => {
        connections.delete(conn);
        opts.logger.info({ conn: conn.id }, 'websocket disconnected');
      });
    });
  };
  app.server.on('upgrade', onUpgrade);

  const heartbeat = setInterval(() => {
    for (const conn of connections) {
      if (!conn.isAlive) {
        conn.kill();
        continue;
      }
      conn.isAlive = false;
      conn.ping();
    }
  }, opts.heartbeatMs ?? 30_000);
  heartbeat.unref();

  return {
    connections,
    ipSessions: ledger,
    rooms,
    review,
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(heartbeat);
      rooms.close();
      app.server.off('upgrade', onUpgrade);
      const all = [...connections].map((c) => {
        c.close(1001, 'server shutting down');
        return c.whenClosed();
      });
      await Promise.allSettled(all);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      review.close();
    },
  };
}

function headerValue(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}
