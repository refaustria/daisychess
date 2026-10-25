import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type Capabilities,
  type ErrorMessage,
  type RoomClientMessage,
  type RoomErrorMessage,
  type RoomSeatMessage,
  type RoomStateMessage,
} from '@daisychess/engine-core';
import type { WebSocketLike } from '../engine/RemoteEngineClient';

/** `WebSocket.OPEN` (not referenced through the global so the module loads without one). */
const WS_OPEN = 1;

export type RoomConnectionStatus = 'off' | 'connecting' | 'online' | 'retrying';

export type RoomServerMessage = RoomSeatMessage | RoomStateMessage | RoomErrorMessage;

export interface RoomConnectionOptions {
  url: string;
  /** Sent in `hello.token` when non-empty (optional for rooms, ADR-013). */
  token?: () => string | undefined;
  createSocket?: (url: string) => WebSocketLike;
  /** Max time from opening the socket to `welcome`. Default 10 s. */
  handshakeTimeoutMs?: number;
  /** Backoff before reconnect attempt `attempt` (0-based). */
  reconnectDelay?: (attempt: number) => number;
  /** Called with every room message (after the handshake). */
  onMessage(msg: RoomServerMessage): void;
  /** Envelope errors (`rate_limited`, `invalid_message`, …): client-side bugs or overload. */
  onProtocolError?(msg: ErrorMessage): void;
  /** Status changes; `online` after every (re)handshake — the owner re-attaches then. */
  onStatus(status: RoomConnectionStatus, info: { reconnected: boolean }): void;
  /** The server does not offer rooms (`capabilities.rooms` false or absent). Stops retrying. */
  onUnsupported?(): void;
}

export const ROOM_RECONNECT_BASE_MS = 500;
export const ROOM_RECONNECT_MAX_MS = 15_000;

export const defaultReconnectDelay = (attempt: number): number =>
  Math.min(ROOM_RECONNECT_MAX_MS, ROOM_RECONNECT_BASE_MS * 2 ** Math.min(attempt, 10));

/**
 * The dedicated `/ws` connection for rooms (ADR-013): `hello` (token optional) → `welcome`, then
 * `room.*` messages. A dropped connection (or a failed handshake) is retried with exponential
 * backoff until {@link close}; every successful handshake reports `online` so the owner can send
 * `room.attach` again. Messages sent while offline are dropped (the owner re-syncs on `online`).
 */
export class RoomConnection {
  private readonly o: RoomConnectionOptions;
  private socket: WebSocketLike | null = null;
  private status: RoomConnectionStatus = 'off';
  private handshaken = false;
  private everOnline = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = true;
  capabilities: Capabilities | null = null;

  constructor(o: RoomConnectionOptions) {
    this.o = o;
  }

  get connectionStatus(): RoomConnectionStatus {
    return this.status;
  }

  get online(): boolean {
    return this.status === 'online';
  }

  /** Opens the connection (idempotent while open or retrying). */
  open(): void {
    if (!this.closed) return;
    this.closed = false;
    this.attempt = 0;
    this.everOnline = false;
    this.connect();
  }

  /** Closes for good (no reconnect). */
  close(): void {
    this.closed = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    this.handshaken = false;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close(1000, 'bye');
      } catch {
        /* already closed */
      }
    }
    this.setStatus('off');
  }

  /** Sends a room message; false when not online (the message is dropped). */
  send(msg: RoomClientMessage): boolean {
    const s = this.socket;
    if (!s || !this.handshaken || s.readyState !== WS_OPEN) return false;
    s.send(JSON.stringify(msg));
    return true;
  }

  private setStatus(status: RoomConnectionStatus, reconnected = false): void {
    if (status === this.status && status !== 'online') return;
    this.status = status;
    this.o.onStatus(status, { reconnected });
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    this.retryTimer = this.handshakeTimer = null;
  }

  private connect(): void {
    if (this.closed) return;
    this.setStatus(this.attempt === 0 && !this.everOnline ? 'connecting' : 'retrying');
    this.handshaken = false;
    let socket: WebSocketLike;
    try {
      socket = (this.o.createSocket ?? ((url: string): WebSocketLike => new WebSocket(url)))(
        this.o.url,
      );
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => {
      if (this.socket === socket && !this.handshaken) this.drop(socket);
    }, this.o.handshakeTimeoutMs ?? 10_000);

    socket.onopen = () => {
      const token = this.o.token?.();
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          client: { name: 'daisychess-web-rooms' },
          ...(token ? { token } : {}),
        }),
      );
    };
    socket.onmessage = (ev: MessageEvent) => {
      if (this.socket !== socket) return;
      const parsed = parseServerMessage(ev.data);
      if (!parsed.ok) {
        console.warn(`[rooms] ignoring invalid server message: ${parsed.error}`);
        return;
      }
      const msg = parsed.message;
      if (!this.handshaken) {
        if (msg.type === 'welcome') {
          if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
          this.handshakeTimer = null;
          this.capabilities = msg.capabilities ?? { analysis: true, rooms: false };
          if (!this.capabilities.rooms) {
            this.close();
            this.o.onUnsupported?.();
            return;
          }
          this.handshaken = true;
          const reconnected = this.everOnline;
          this.everOnline = true;
          this.attempt = 0;
          this.setStatus('online', reconnected);
        } else if (msg.type === 'error') {
          this.o.onProtocolError?.(msg);
        }
        return;
      }
      switch (msg.type) {
        case 'room.seat':
        case 'room.state':
        case 'room.error':
          this.o.onMessage(msg);
          break;
        case 'error':
          this.o.onProtocolError?.(msg);
          break;
        default:
          break;
      }
    };
    socket.onerror = () => {
      // `close` follows.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.drop(socket);
    };
  }

  private drop(socket: WebSocketLike): void {
    if (this.socket !== socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.handshaken = false;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.closed) return;
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.setStatus('retrying');
    const delay = (this.o.reconnectDelay ?? defaultReconnectDelay)(this.attempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}
