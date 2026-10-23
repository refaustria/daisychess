import {
  DEFAULT_LIMITS,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type WelcomeMessage,
} from '@chesslab/engine-core';
import type { WebSocketLike } from './RemoteEngineClient';

export const TEST_WELCOME: WelcomeMessage = {
  type: 'welcome',
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: '0.0.0-test',
  limits: { ...DEFAULT_LIMITS },
  engines: [
    { id: 'fairy', name: 'Fairy-Stockfish', enabled: false, defaults: { threads: 2, hash: 128 } },
    { id: 'stockfish', name: 'Stockfish 19', enabled: true, defaults: { threads: 4, hash: 256 } },
  ],
};

/**
 * Scriptable fake `WebSocket` playing the server side of ADR-006 in unit tests.
 * Every client frame is validated with `parseClientMessage` (an off-contract frame throws).
 * With `autoOpen`/`welcome` set (default) it opens on the next microtask and answers `hello`.
 */
export class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  /** Parsed client messages in order. */
  readonly sent: ClientMessage[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  /** Reply to `hello`; null = no automatic reply. */
  welcome: ServerMessage | null = TEST_WELCOME;

  constructor(
    readonly url: string,
    autoOpen = true,
  ) {
    if (autoOpen) queueMicrotask(() => this.open());
  }

  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('FakeWebSocket: send on a socket that is not open');
    const parsed = parseClientMessage(data);
    if (!parsed.ok) throw new Error(`FakeWebSocket: off-contract client frame: ${parsed.error}`);
    this.sent.push(parsed.message);
    if (parsed.message.type === 'hello' && this.welcome) {
      const reply = this.welcome;
      queueMicrotask(() => this.emit(reply));
    }
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  /** Delivers a server message (validated against `ServerMessageSchema`). */
  emit(msg: ServerMessage): void {
    ServerMessageSchema.parse(msg);
    this.emitRaw(JSON.stringify(msg));
  }

  emitRaw(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** Server-side close (or network loss). */
  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  /** Messages of one type sent by the client. */
  ofType<T extends ClientMessage['type']>(type: T): Extract<ClientMessage, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: T }> => m.type === type);
  }
}
