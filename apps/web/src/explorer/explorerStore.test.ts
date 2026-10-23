// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_STORAGE_KEY, resetLichessAuth } from '../lichess/auth';
import { useGameStore } from '../store/gameStore';
import type { ExplorerFetch } from './client';
import {
  DEBOUNCE_MS,
  DEFAULT_RATINGS,
  plyOfFen,
  queryFor,
  resetExplorerRuntime,
  setExplorerFetch,
  STORAGE_KEY,
  useExplorerStore,
} from './explorerStore';
import { htmlResponse, jsonResponse, LICHESS_E4, MASTERS_START } from './fixtures';

const store = () => useExplorerStore.getState();
const game = () => useGameStore.getState();

let fetchMock: ReturnType<typeof vi.fn<ExplorerFetch>>;

/** Lets resolved fetch promises run their continuations. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetLichessAuth();
  resetExplorerRuntime();
  useExplorerStore.setState({ active: false, status: 'idle', key: undefined, data: undefined, error: undefined, db: 'masters', token: '' });
  game().reset();
  fetchMock = vi.fn<ExplorerFetch>(async () => jsonResponse(MASTERS_START));
  setExplorerFetch(fetchMock);
});

afterEach(() => {
  store().setActive(false);
  setExplorerFetch(undefined);
  vi.useRealTimers();
});

describe('helpers', () => {
  it('plyOfFen counts plies from the standard start', () => {
    expect(plyOfFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe(0);
    expect(plyOfFen('x b - - 0 1')).toBe(1);
    expect(plyOfFen('x w - - 0 26')).toBe(50);
    expect(plyOfFen('x b - - 0 26')).toBe(51);
  });

  it('queryFor uses the start FEN + UCI moves up to the viewed ply; "all" filters are omitted', () => {
    game().makeMove('e2', 'e4');
    game().makeMove('e7', 'e5');
    game().prev();
    const q = queryFor(game(), { db: 'lichess', speeds: ['blitz'], ratings: [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500], token: '' });
    expect(q.play).toEqual(['e2e4']);
    expect(q.speeds).toEqual(['blitz']);
    expect(q.ratings).toBeUndefined();
  });
});

describe('explorerStore', () => {
  it('does nothing while inactive', async () => {
    game().makeMove('e2', 'e4');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store().status).toBe('idle');
  });

  it('fetches on activation, then follows the position with a debounce', async () => {
    store().setActive(true);
    expect(store().status).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store().status).toBe('ready');
    expect(store().data?.moves).toHaveLength(3);

    game().makeMove('e2', 'e4');
    game().makeMove('e7', 'e5');
    game().makeMove('g1', 'f3');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); // only the last position
    expect(fetchMock.mock.calls[1]?.[0]).toContain('play=e2e4%2Ce7e5%2Cg1f3');
  });

  it('serves revisited positions from the cache without a request', async () => {
    store().setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    game().makeMove('e2', 'e4');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    game().goTo(0);
    expect(store().status).toBe('ready'); // synchronous cache hit
    game().goTo(1);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts a stale request and ignores its late answer', async () => {
    const pending: { resolve: (r: Response) => void; signal?: AbortSignal }[] = [];
    fetchMock.mockImplementation(
      (_u, init) =>
        new Promise<Response>((resolve) => {
          pending.push({ resolve, ...(init.signal ? { signal: init.signal } : {}) });
        }),
    );
    store().setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(1);
    game().makeMove('e2', 'e4');
    expect(pending[0]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(pending).toHaveLength(2);
    pending[1]?.resolve(jsonResponse(LICHESS_E4));
    await flush();
    pending[0]?.resolve(jsonResponse(MASTERS_START)); // late, stale
    await flush();
    expect(store().data?.opening?.name).toBe("King's Pawn");
  });

  it('switching db or filters refetches; filters are ignored for masters', async () => {
    store().setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    store().setSpeeds(['blitz']); // masters: same key, no request
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    store().setDb('lichess');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(/\/lichess\?.*speeds=blitz/);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({ db: 'lichess', speeds: ['blitz'] });
  });

  it('setActive(false) stops following and aborts', async () => {
    store().setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    store().setActive(false);
    game().makeMove('e2', 'e4');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store().status).toBe('idle');
    store().setActive(true); // cached start? no: position is now after e4 → request
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('anonymous 401 → token required; no more anonymous requests; a token retries', async () => {
    fetchMock.mockImplementation(async (_u, init) =>
      init.headers.Authorization ? jsonResponse(MASTERS_START) : htmlResponse(401),
    );
    store().setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(store().status).toBe('error');
    expect(store().error).toMatchObject({ kind: 'unauthorized', withToken: false });
    game().makeMove('e2', 'e4');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    store().setToken(' lip_abc ');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1].headers.Authorization).toBe('Bearer lip_abc');
    expect(store().status).toBe('ready');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').token).toBe('lip_abc');
  });

  it('uses the lichess login token over a pasted one', async () => {
    useExplorerStore.setState({ token: 'lip_pasted' });
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'lio_login', username: 'Alice', scopes: [] }));
    resetLichessAuth();
    store().setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer lio_login');
  });

  it('logging in with lichess retries a token-required error with the new token', async () => {
    fetchMock.mockImplementation(async (_u, init) =>
      init.headers.Authorization ? jsonResponse(MASTERS_START) : htmlResponse(401),
    );
    store().setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(store().error).toMatchObject({ kind: 'unauthorized', withToken: false });
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'lio_login', username: 'Alice', scopes: [] }));
    resetLichessAuth();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1].headers.Authorization).toBe('Bearer lio_login');
    expect(store().status).toBe('ready');
    // The login token is never written into the explorer's own storage.
    expect(localStorage.getItem(STORAGE_KEY) ?? '').not.toContain('lio_login');
  });

  it('429 → rate_limited, holds requests back and retries after Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(429, { 'Retry-After': '5' }));
    store().setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(store().error).toMatchObject({ kind: 'rate_limited', retryAfter: 5 });
    await vi.advanceTimersByTimeAsync(4900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store().status).toBe('ready');
  });

  it('positions beyond 50 plies are not requested', async () => {
    useGameStore.getState().loadFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 40');
    store().setActive(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(store().status).toBe('too_deep');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('network errors are retried by refresh()', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    store().setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(store().error?.kind).toBe('network');
    store().refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(store().status).toBe('ready');
  });
});

describe('persistence', () => {
  it('reads settings from localStorage, sanitising bad values', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ db: 'lichess', speeds: ['blitz', 'nope'], ratings: [], token: 'lip_x' }),
    );
    vi.resetModules();
    const mod = await import('./explorerStore');
    const s = mod.useExplorerStore.getState();
    expect(s.db).toBe('lichess');
    expect(s.speeds).toEqual(['blitz']);
    expect(s.ratings).toEqual(DEFAULT_RATINGS);
    expect(s.token).toBe('lip_x');
  });
});
