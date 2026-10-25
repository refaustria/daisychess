import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from '../engine/remoteTesting';
import { FakeReviewServer } from '../review/fakeReviewServer';
import { useAnalysisStore } from '../store/analysisStore';
import { useSettingsStore } from '../store/settingsStore';
import {
  API_COOLDOWN_MS,
  API_HANDSHAKE_TIMEOUT_MS,
  API_IDLE_MS,
  API_REQUEST_TIMEOUT_MS,
  apiCapabilities,
  apiInCooldown,
  apiRequest,
  canWriteReviews,
  configureApiConnection,
  isApiError,
} from './apiConnection';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KEY = 'a'.repeat(64);

let server: FakeReviewServer;

/** Lets the fake socket open and the handshake/replies (microtasks) settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return isApiError(err) ? err.code : 'other';
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeReviewServer();
  configureApiConnection({ createSocket: server.createSocket });
  useSettingsStore.getState().setServerToken('');
});

afterEach(() => {
  configureApiConnection(null);
  useSettingsStore.getState().setServerToken('');
  vi.useRealTimers();
});

describe('apiConnection', () => {
  it('opens on the first request, says hello with the token and correlates the reply', async () => {
    useSettingsStore.getState().setServerToken('secret');
    server.token = 'secret';
    const p = apiRequest({ type: 'review.get', gameKey: KEY, startFen: START, moves: ['e4', 'e5'] });
    await flush();
    const reply = await p;
    expect(reply).toEqual({ type: 'review.record', gameKey: KEY, found: false });
    expect(server.sockets).toHaveLength(1);
    const hello = server.sockets[0]!.ofType('hello')[0]!;
    expect(hello).toMatchObject({ token: 'secret', client: { name: 'daisychess-web-api' } });
    expect(apiCapabilities()).toEqual({ analysis: true, rooms: true, reviewStore: true });
    expect(canWriteReviews()).toBe(true);
  });

  it('reports analysis: false (no write) when the token is missing', async () => {
    server.token = 'secret';
    const p = apiRequest({ type: 'review.stats.get' });
    await flush();
    await expect(p).resolves.toMatchObject({ type: 'review.stats', enabled: true });
    expect(canWriteReviews()).toBe(false);
    const hello = server.sockets[0]!.ofType('hello')[0]!;
    expect(hello.token).toBeUndefined();
  });

  it('keeps replies apart by key and shares one frame between identical requests', async () => {
    const other = 'b'.repeat(64);
    server.put({
      gameKey: other,
      startFen: START,
      moves: ['d4', 'd5'],
      preset: 'fast',
      record: {
        version: 1,
        options: { movetime: 300 },
        engine: { kind: 'browser' },
        summary: {
          white: { accuracy: 0, counts: { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, forced: 0 } },
          black: { accuracy: 0, counts: { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, forced: 0 } },
          moves: [],
        },
        moveDetails: {},
      },
      createdAt: 5,
    });
    server.delayMs = 50;
    const a1 = apiRequest({ type: 'review.get', gameKey: KEY, startFen: START, moves: ['e4', 'e5'] });
    const a2 = apiRequest({ type: 'review.get', gameKey: KEY, startFen: START, moves: ['e4', 'e5'] });
    const b = apiRequest({ type: 'review.get', gameKey: other, startFen: START, moves: ['d4', 'd5'] });
    await flush();
    // Welcome after 50 ms, replies 50 ms after the requests that follow it.
    await vi.advanceTimersByTimeAsync(200);
    expect(await a1).toMatchObject({ gameKey: KEY, found: false });
    expect(await a2).toMatchObject({ gameKey: KEY, found: false });
    expect(await b).toMatchObject({ gameKey: other, found: true, preset: 'fast' });
    // Identical requests were sent once.
    expect(server.of('review.get').filter((m) => m.gameKey === KEY)).toHaveLength(1);
  });

  it('times out a request without reply', async () => {
    server.mute = true;
    const result = code(apiRequest({ type: 'review.stats.get' }));
    await flush();
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS + 1);
    expect(await result).toBe('timeout');
  });

  it('rejects pending requests when the socket closes and reconnects for the next one', async () => {
    server.mute = true;
    const result = code(apiRequest({ type: 'review.stats.get' }));
    await flush();
    server.sockets[0]!.serverClose();
    expect(await result).toBe('closed');
    server.mute = false;
    const p2 = apiRequest({ type: 'review.stats.get' });
    await flush();
    await expect(p2).resolves.toMatchObject({ type: 'review.stats' });
    expect(server.sockets).toHaveLength(2);
  });

  it('after a failed handshake, requests fail fast for the cooldown period', async () => {
    let created = 0;
    configureApiConnection({
      createSocket: (url) => {
        created++;
        return new FakeWebSocket(url, false); // never opens
      },
    });
    const result = code(apiRequest({ type: 'review.stats.get' }));
    await vi.advanceTimersByTimeAsync(API_HANDSHAKE_TIMEOUT_MS + 1);
    expect(await result).toBe('unavailable');
    expect(created).toBe(1);
    expect(apiInCooldown()).toBe(true);
    expect(await code(apiRequest({ type: 'review.stats.get' }))).toBe('unavailable');
    expect(created).toBe(1); // no new socket during the cooldown
    await vi.advanceTimersByTimeAsync(API_COOLDOWN_MS);
    void apiRequest({ type: 'review.stats.get' }).catch(() => undefined);
    await flush();
    expect(created).toBe(2);
    await vi.advanceTimersByTimeAsync(API_HANDSHAKE_TIMEOUT_MS + 1);
  });

  it('treats a server without review store as unsupported (with cooldown)', async () => {
    server.capabilities = { analysis: true, rooms: true };
    const p = apiRequest({ type: 'review.stats.get' });
    await flush();
    expect(await code(p)).toBe('unsupported');
    expect(await code(apiRequest({ type: 'review.stats.get' }))).toBe('unsupported');
    expect(server.sockets).toHaveLength(1);
    expect(canWriteReviews()).toBe(false);
  });

  it('closes an idle connection and reopens on demand', async () => {
    const p = apiRequest({ type: 'review.stats.get' });
    await flush();
    await p;
    expect(server.sockets[0]!.closedWith).toBeNull();
    await vi.advanceTimersByTimeAsync(API_IDLE_MS + 1);
    expect(server.sockets[0]!.closedWith).toEqual({ code: 1000, reason: 'bye' });
    const p2 = apiRequest({ type: 'review.stats.get' });
    await flush();
    await p2;
    expect(server.sockets).toHaveLength(2);
  });

  it('drops the connection when the token or the server URL changes', async () => {
    const p = apiRequest({ type: 'review.stats.get' });
    await flush();
    await p;
    useSettingsStore.getState().setServerToken('new-token');
    expect(server.sockets[0]!.closedWith).toEqual({ code: 1000, reason: 'bye' });
    const p2 = apiRequest({ type: 'review.stats.get' });
    await flush();
    await p2;
    expect(server.sockets).toHaveLength(2);
    expect(server.sockets[1]!.ofType('hello')[0]!.token).toBe('new-token');
    useAnalysisStore.getState().setSettings({ remoteUrl: 'ws://other.test/ws' });
    expect(server.sockets[1]!.closedWith).toEqual({ code: 1000, reason: 'bye' });
    const p3 = apiRequest({ type: 'review.stats.get' });
    await flush();
    await p3;
    expect(server.sockets[2]!.url).toBe('ws://other.test/ws');
    useAnalysisStore.getState().setSettings({ remoteUrl: undefined });
  });

  it('rejects with unavailable when the api is disabled', async () => {
    configureApiConnection(null);
    expect(await code(apiRequest({ type: 'review.stats.get' }))).toBe('unavailable');
    expect(server.sockets).toHaveLength(0);
  });
});
