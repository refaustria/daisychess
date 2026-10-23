import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import { MAX_MESSAGE_BYTES } from '@chesslab/engine-core';
import { Connection, type ConnectionOptions } from './connection.js';
import { isOriginAllowed, type OriginPolicy } from './origin.js';

export interface WsServerOptions extends ConnectionOptions {
  /** URL path that accepts upgrades. Default `/ws`. */
  path?: string;
  /** Interval of WebSocket pings; a connection that missed one pong is terminated. Default 30 s. */
  heartbeatMs?: number;
  /** Browser `Origin` policy (ADR-008). Default: same host as the request. */
  allowedOrigins?: OriginPolicy;
}

export interface WsServerHandle {
  readonly connections: ReadonlySet<Connection>;
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
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    clientTracking: false,
  });
  const connections = new Set<Connection>();
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
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new Connection(ws, opts);
      connections.add(conn);
      opts.logger.info(
        {
          conn: conn.id,
          // nginx forwards the client address; never log anything else from the request.
          ip: headerValue(req.headers['x-real-ip']) ?? req.socket.remoteAddress,
        },
        'websocket connected',
      );
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
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(heartbeat);
      app.server.off('upgrade', onUpgrade);
      const all = [...connections].map((c) => {
        c.close(1001, 'server shutting down');
        return c.whenClosed();
      });
      await Promise.allSettled(all);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function headerValue(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}
