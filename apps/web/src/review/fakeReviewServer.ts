/**
 * Scriptable fake of the server review store (ADR-017) for unit tests: a `FakeWebSocket` that
 * answers `review.*` requests from an in-memory store shared by every socket it creates, so tests
 * can simulate "another device stored it" and "the token is missing".
 */
import {
  DEFAULT_LIMITS,
  PROTOCOL_VERSION,
  type Capabilities,
  type ClientMessage,
  type PositionResult,
  type ReviewPreset,
  type ServerMessage,
  type StoredReviewRecord,
} from '@daisychess/engine-core';
import { FakeWebSocket } from '../engine/remoteTesting';

export interface FakeStoredReview {
  gameKey: string;
  startFen: string;
  moves: string[];
  preset: ReviewPreset;
  record: StoredReviewRecord;
  createdAt: number;
}

export class FakeReviewServer {
  readonly reviews = new Map<string, FakeStoredReview>();
  /** `${optsKey}|${fen}` → result */
  readonly positions = new Map<string, PositionResult>();
  /** Every socket created, in order. */
  readonly sockets: FakeReviewSocket[] = [];
  /** Every `review.*` request received, in order. */
  readonly requests: ClientMessage[] = [];
  /** Capabilities announced; `analysis` is set per hello from the token below. */
  capabilities: Capabilities = { analysis: true, rooms: true, reviewStore: true };
  /** When set, only a hello with this token gets `analysis: true`. */
  token: string | null = null;
  /** Stops answering requests (timeouts). */
  mute = false;
  /** Reply delay in ms (0 = microtask). */
  delayMs = 0;
  maxBytes = 5e9;
  bytes = 1_200_000_000;

  createSocket = (url: string): FakeReviewSocket => {
    const s = new FakeReviewSocket(url, this);
    this.sockets.push(s);
    return s;
  };

  put(r: FakeStoredReview): void {
    this.reviews.set(r.gameKey, r);
  }

  putPosition(optsKey: string, fen: string, result: PositionResult): void {
    this.positions.set(`${optsKey}|${fen}`, result);
  }

  of<T extends ClientMessage['type']>(type: T): Extract<ClientMessage, { type: T }>[] {
    return this.requests.filter((m): m is Extract<ClientMessage, { type: T }> => m.type === type);
  }

  /** The reply to one request from one connection. */
  answer(msg: ClientMessage, analysis: boolean): ServerMessage | null {
    switch (msg.type) {
      case 'review.get': {
        const r = this.reviews.get(msg.gameKey);
        if (!r || r.startFen !== msg.startFen || r.moves.join(' ') !== msg.moves.join(' ')) {
          return { type: 'review.record', gameKey: msg.gameKey, found: false };
        }
        return {
          type: 'review.record',
          gameKey: msg.gameKey,
          found: true,
          preset: r.preset,
          record: r.record,
          createdAt: r.createdAt,
        };
      }
      case 'review.put': {
        if (!analysis)
          return { type: 'review.stored', gameKey: msg.gameKey, stored: false, reason: 'unauthorized' };
        this.put({
          gameKey: msg.gameKey,
          startFen: msg.startFen,
          moves: msg.moves,
          preset: msg.preset,
          record: msg.record,
          createdAt: Date.now(),
        });
        return { type: 'review.stored', gameKey: msg.gameKey, stored: true };
      }
      case 'review.positions.get': {
        const results: Record<string, PositionResult> = {};
        for (const fen of msg.fens) {
          const r = this.positions.get(`${msg.optsKey}|${fen}`);
          if (r) results[fen] = r;
        }
        return { type: 'review.positions', optsKey: msg.optsKey, results };
      }
      case 'review.positions.put': {
        if (!analysis) {
          return {
            type: 'review.positions.stored',
            optsKey: msg.optsKey,
            stored: false,
            reason: 'unauthorized',
          };
        }
        for (const e of msg.entries) this.putPosition(msg.optsKey, e.fen, e.result);
        return { type: 'review.positions.stored', optsKey: msg.optsKey, stored: true };
      }
      case 'review.stats.get':
        return {
          type: 'review.stats',
          enabled: true,
          reviews: this.reviews.size,
          positions: this.positions.size,
          bytes: this.bytes,
          maxBytes: this.maxBytes,
        };
      default:
        return null;
    }
  }
}

export class FakeReviewSocket extends FakeWebSocket {
  analysis = true;

  constructor(
    url: string,
    readonly server: FakeReviewServer,
  ) {
    super(url);
    this.welcome = null; // answered below with per-hello capabilities
  }

  override send(data: string): void {
    super.send(data);
    const msg = this.sent.at(-1)!;
    if (msg.type === 'hello') {
      this.analysis = this.server.token === null || msg.token === this.server.token;
      this.reply({
        type: 'welcome',
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: '0.0.0-test',
        limits: { ...DEFAULT_LIMITS },
        engines: [],
        capabilities: { ...this.server.capabilities, analysis: this.analysis },
      });
      return;
    }
    if (!msg.type.startsWith('review.')) return;
    this.server.requests.push(msg);
    if (this.server.mute) return;
    const reply = this.server.answer(msg, this.analysis);
    if (reply) this.reply(reply);
  }

  private reply(msg: ServerMessage): void {
    const deliver = () => {
      if (this.readyState === 1) this.emit(msg);
    };
    if (this.server.delayMs > 0) setTimeout(deliver, this.server.delayMs);
    else queueMicrotask(deliver);
  }
}
