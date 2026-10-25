/**
 * One shared, lightweight `/ws` connection for request/response traffic that is neither an
 * engine session nor a room (ADR-017: the server review store). Opens on the first request
 * (`hello` with the access token when one is set), correlates every reply by its `type` and key
 * (`gameKey` / `optsKey`), closes itself {@link API_IDLE_MS} after the last settled request and
 * reopens on demand. Failures are remembered for {@link API_COOLDOWN_MS} so a down server costs
 * one connect attempt per minute, not one per review.
 *
 * Framework-free apart from reading the two settings stores (server URL, token); their changes
 * drop the connection so the next request handshakes with the new values.
 */
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type Capabilities,
  type ClientMessage,
  type ServerMessage,
} from '@daisychess/engine-core';
import type { WebSocketLike } from '../engine/RemoteEngineClient';
import { defaultServerUrl } from '../engine/serverUrl';
import { useAnalysisStore } from '../store/analysisStore';
import { useSettingsStore } from '../store/settingsStore';

/** `WebSocket.OPEN` (not referenced through the global so the module loads without one). */
const WS_OPEN = 1;

export const API_HANDSHAKE_TIMEOUT_MS = 3_000;
export const API_REQUEST_TIMEOUT_MS = 10_000;
export const API_IDLE_MS = 60_000;
export const API_COOLDOWN_MS = 60_000;

export type ApiErrorCode =
  /** No api configured (tests), a recent failure (cooldown) or the socket could not be opened. */
  | 'unavailable'
  /** The server does not offer the review store (`capabilities.reviewStore` false/absent). */
  | 'unsupported'
  /** The socket closed before the reply arrived. */
  | 'closed'
  /** No reply within {@link API_REQUEST_TIMEOUT_MS}. */
  | 'timeout';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const isApiError = (err: unknown): err is ApiError => err instanceof ApiError;

/** Client review requests and the reply type each one is answered with. */
export type ApiRequest = Extract<ClientMessage, { type: `review.${string}` }>;
type ReplyOf<T extends ApiRequest['type']> = T extends 'review.get'
  ? Extract<ServerMessage, { type: 'review.record' }>
  : T extends 'review.put'
    ? Extract<ServerMessage, { type: 'review.stored' }>
    : T extends 'review.positions.get'
      ? Extract<ServerMessage, { type: 'review.positions' }>
      : T extends 'review.positions.put'
        ? Extract<ServerMessage, { type: 'review.positions.stored' }>
        : T extends 'review.stats.get'
          ? Extract<ServerMessage, { type: 'review.stats' }>
          : never;

const REPLY_TYPE: Record<ApiRequest['type'], ServerMessage['type']> = {
  'review.get': 'review.record',
  'review.put': 'review.stored',
  'review.positions.get': 'review.positions',
  'review.positions.put': 'review.positions.stored',
  'review.stats.get': 'review.stats',
};

/** Correlation key: reply type plus the game/options key the request carries. */
function keyOf(type: string, msg: { gameKey?: string; optsKey?: string }): string {
  return `${type}\n${msg.gameKey ?? msg.optsKey ?? ''}`;
}

interface Pending {
  resolve(msg: ServerMessage): void;
  reject(err: ApiError): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ApiConnectionOptions {
  createSocket?: (url: string) => WebSocketLike;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  idleMs?: number;
  cooldownMs?: number;
}

/** `undefined`: the browser `WebSocket`; `null`: api disabled (tests). */
let config: ApiConnectionOptions | null | undefined;

let socket: WebSocketLike | null = null;
let handshaken = false;
let opening: Promise<void> | null = null;
let capabilities: Capabilities | null = null;
let failedUntil = 0;
let failedCode: ApiErrorCode = 'unavailable';
const pending = new Map<string, Pending>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
let subscribed = false;

const opt = <K extends keyof ApiConnectionOptions>(
  k: K,
  fallback: NonNullable<ApiConnectionOptions[K]>,
): NonNullable<ApiConnectionOptions[K]> => (config ? (config[k] ?? fallback) : fallback);

function url(): string {
  return useAnalysisStore.getState().settings.remoteUrl ?? defaultServerUrl();
}

function token(): string | undefined {
  const t = useSettingsStore.getState().serverToken;
  return t ? t : undefined;
}

/**
 * Selects the socket factory (tests) or disables the api (`null`: every request rejects with
 * `unavailable`, no socket is ever created). Drops the current connection and forgets failures.
 */
export function configureApiConnection(opts: ApiConnectionOptions | null | undefined): void {
  config = opts;
  resetApiConnection();
}

/** Closes the connection (pending requests fail with `closed`) and forgets the cooldown. */
export function resetApiConnection(): void {
  drop('closed');
  failedUntil = 0;
  capabilities = null;
}

/** Capabilities of the last successful handshake (null before one). */
export function apiCapabilities(): Capabilities | null {
  return capabilities;
}

/**
 * True when the server has a review store and accepted this connection's token (or is public):
 * `review.put` is allowed.
 */
export function canWriteReviews(): boolean {
  return capabilities?.analysis === true && capabilities.reviewStore === true;
}

/** True unless the api is disabled by {@link configureApiConnection}(null). */
export function apiConfigured(): boolean {
  return config !== null;
}

/** True while a recent failure keeps requests from being sent. */
export function apiInCooldown(): boolean {
  return failedUntil > Date.now();
}

function watchSettings(): void {
  if (subscribed) return;
  subscribed = true;
  let lastToken = useSettingsStore.getState().serverToken;
  useSettingsStore.subscribe((s) => {
    if (s.serverToken === lastToken) return;
    lastToken = s.serverToken;
    resetApiConnection();
  });
  let lastUrl = useAnalysisStore.getState().settings.remoteUrl;
  useAnalysisStore.subscribe((s) => {
    if (s.settings.remoteUrl === lastUrl) return;
    lastUrl = s.settings.remoteUrl;
    resetApiConnection();
  });
}

function fail(code: ApiErrorCode): void {
  failedUntil = Date.now() + opt('cooldownMs', API_COOLDOWN_MS);
  failedCode = code;
}

/** Closes the socket; pending requests are rejected with `code`. */
function drop(code: ApiErrorCode): void {
  const s = socket;
  socket = null;
  handshaken = false;
  opening = null;
  if (handshakeTimer !== null) clearTimeout(handshakeTimer);
  handshakeTimer = null;
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  if (s) {
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close(1000, 'bye');
    } catch {
      /* already closed */
    }
  }
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new ApiError('connection closed', code));
  }
  pending.clear();
}

function armIdle(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pending.size === 0) drop('closed');
  }, opt('idleMs', API_IDLE_MS));
}

/** Opens the socket and completes the handshake (shared by concurrent callers). */
function open(): Promise<void> {
  if (socket && handshaken) return Promise.resolve();
  if (opening) return opening;
  opening = new Promise<void>((resolve, reject) => {
    const create = config?.createSocket ?? ((u: string): WebSocketLike => new WebSocket(u));
    let s: WebSocketLike;
    try {
      s = create(url());
    } catch (err) {
      fail('unavailable');
      opening = null;
      reject(new ApiError(`cannot open ${url()}: ${(err as Error).message}`, 'unavailable'));
      return;
    }
    socket = s;
    const settle = (err?: ApiError) => {
      if (handshakeTimer !== null) clearTimeout(handshakeTimer);
      handshakeTimer = null;
      opening = null;
      if (err) {
        fail(err.code);
        if (socket === s) drop(err.code);
        reject(err);
      } else resolve();
    };
    handshakeTimer = setTimeout(
      () => settle(new ApiError('handshake timeout', 'unavailable')),
      opt('handshakeTimeoutMs', API_HANDSHAKE_TIMEOUT_MS),
    );
    s.onopen = () => {
      const t = token();
      s.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          client: { name: 'daisychess-web-api' },
          ...(t ? { token: t } : {}),
        }),
      );
    };
    s.onmessage = (ev: MessageEvent) => {
      if (socket !== s) return;
      const parsed = parseServerMessage(ev.data);
      if (!parsed.ok) {
        console.warn(`[api] ignoring invalid server message: ${parsed.error}`);
        return;
      }
      const msg = parsed.message;
      if (!handshaken) {
        if (msg.type === 'welcome') {
          capabilities = msg.capabilities ?? { analysis: true, rooms: false };
          if (capabilities.reviewStore !== true) {
            settle(new ApiError('server has no review store', 'unsupported'));
            return;
          }
          handshaken = true;
          failedUntil = 0;
          settle();
          armIdle();
        } else if (msg.type === 'error') {
          settle(new ApiError(msg.message, 'unavailable'));
        }
        return;
      }
      const p = pending.get(keyOf(msg.type, msg as { gameKey?: string; optsKey?: string }));
      if (!p) return;
      pending.delete(keyOf(msg.type, msg as { gameKey?: string; optsKey?: string }));
      clearTimeout(p.timer);
      p.resolve(msg);
      if (pending.size === 0) armIdle();
    };
    s.onerror = () => {
      /* `close` follows */
    };
    s.onclose = () => {
      if (socket !== s) return;
      if (!handshaken) settle(new ApiError('connection closed during handshake', 'unavailable'));
      else drop('closed');
    };
  });
  return opening;
}

/**
 * Sends a `review.*` request and resolves with its reply. Rejects with an {@link ApiError}
 * (`unavailable`, `unsupported`, `closed`, `timeout`). Concurrent identical requests (same type
 * and key) share one reply.
 */
export async function apiRequest<T extends ApiRequest>(msg: T): Promise<ReplyOf<T['type']>> {
  if (config === null) throw new ApiError('api disabled', 'unavailable');
  if (failedUntil > Date.now()) throw new ApiError('server unavailable (cooldown)', failedCode);
  watchSettings();
  await open();
  const s = socket;
  if (!s || !handshaken || s.readyState !== WS_OPEN) throw new ApiError('not connected', 'closed');
  const key = keyOf(REPLY_TYPE[msg.type], msg as { gameKey?: string; optsKey?: string });
  const existing = pending.get(key);
  if (existing) {
    return new Promise<ReplyOf<T['type']>>((resolve, reject) => {
      const prevResolve = existing.resolve;
      const prevReject = existing.reject;
      existing.resolve = (m) => {
        prevResolve(m);
        resolve(m as ReplyOf<T['type']>);
      };
      existing.reject = (e) => {
        prevReject(e);
        reject(e);
      };
    });
  }
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  return new Promise<ReplyOf<T['type']>>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new ApiError(`no reply to ${msg.type}`, 'timeout'));
      if (pending.size === 0) armIdle();
    }, opt('requestTimeoutMs', API_REQUEST_TIMEOUT_MS));
    pending.set(key, { resolve: (m) => resolve(m as ReplyOf<T['type']>), reject, timer });
    try {
      s.send(JSON.stringify(msg));
    } catch (err) {
      pending.delete(key);
      clearTimeout(timer);
      reject(new ApiError(`send failed: ${(err as Error).message}`, 'closed'));
    }
  });
}
