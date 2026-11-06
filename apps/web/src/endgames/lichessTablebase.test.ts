// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../packages/endgames/test/fixtures/lichess-krpvkr-win.json';
import {
  COOLDOWN_MS,
  createLichessTablebase,
  DEFAULT_RETRY_AFTER_S,
  isAbortError,
  MIN_SPACING_MS,
  parseRetryAfter,
  REQUEST_TIMEOUT_MS,
  tablebaseUrl,
  type TbFetch,
} from './lichessTablebase';

/** Real answer of tablebase.lichess.ovh for this FEN (packages/endgames fixture). */
const FEN = '1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1';
const FEN2 = '1K6/1P1k4/8/8/8/8/r7/2R5 w - - 1 1';
const FEN3 = '1K6/1P1k4/8/8/8/8/r7/2R5 w - - 2 1';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

interface Call {
  url: string;
  init: RequestInit;
  at: number;
}

/** A fetch whose answers the test controls; each call waits for `respond`. */
function controlledFetch() {
  const calls: Call[] = [];
  const waiting: Array<{
    resolve: (r: Response) => void;
    reject: (e: unknown) => void;
  }> = [];
  const fetch: TbFetch = (url, init) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({ url, init, at: Date.now() });
      const w = { resolve, reject };
      waiting.push(w);
      init.signal?.addEventListener('abort', () => {
        waiting.splice(waiting.indexOf(w), 1);
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  return {
    fetch,
    calls,
    respond: (r: Response) => waiting.shift()!.resolve(r),
    fail: (e: unknown = new TypeError('Failed to fetch')) => waiting.shift()!.reject(e),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('tablebaseUrl / parseRetryAfter', () => {
  it('sends the FEN with underscores for spaces, slashes kept', () => {
    expect(tablebaseUrl('8/8/8/8/8/8/8/K1k5 w - - 0 1')).toBe(
      'https://tablebase.lichess.ovh/standard?fen=8/8/8/8/8/8/8/K1k5_w_-_-_0_1',
    );
    expect(tablebaseUrl('  4k3/8/8/8/8/8/8/4K2R  b   -  - 3 40 ')).toBe(
      'https://tablebase.lichess.ovh/standard?fen=4k3/8/8/8/8/8/8/4K2R_b_-_-_3_40',
    );
  });

  it('reads delta seconds and HTTP dates; defaults to 60 s', () => {
    expect(parseRetryAfter('7', 0)).toBe(7);
    expect(parseRetryAfter('2.2', 0)).toBe(3);
    expect(parseRetryAfter(new Date(1_030_000).toUTCString(), 1_000_000)).toBe(30);
    expect(parseRetryAfter(null, 0)).toBe(DEFAULT_RETRY_AFTER_S);
    expect(parseRetryAfter('soon', 0)).toBe(DEFAULT_RETRY_AFTER_S);
    expect(parseRetryAfter('', 0)).toBe(DEFAULT_RETRY_AFTER_S);
  });
});

describe('createLichessTablebase', () => {
  it('normalises a real answer and sends no credentials', async () => {
    const f = controlledFetch();
    const c = createLichessTablebase({ fetch: f.fetch });
    const p = c.probe(FEN);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(tablebaseUrl(FEN));
    expect(f.calls[0]!.init.credentials).toBe('omit');
    expect(f.calls[0]!.init.headers).toEqual({ Accept: 'application/json' });
    f.respond(json(fixture));
    const pos = await p;
    expect(pos?.category).toBe('win');
    expect(pos?.dtm).toBe(41);
    expect(pos?.fen).toBe(FEN);
    expect(c.available()).toBe(true);
  });

  it('runs one request at a time, at least 100 ms apart', async () => {
    const f = controlledFetch();
    const c = createLichessTablebase({ fetch: f.fetch });
    const results = [c.probe(FEN), c.probe(FEN2), c.probe(FEN3)];
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    // The first answers after 10 ms: the second still waits for the 100 ms spacing.
    await vi.advanceTimersByTimeAsync(10);
    f.respond(json(fixture));
    await vi.advanceTimersByTimeAsync(50);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.at - f.calls[0]!.at).toBeGreaterThanOrEqual(MIN_SPACING_MS);
    // A slow request delays the next one beyond the spacing (concurrency 1).
    await vi.advanceTimersByTimeAsync(500);
    expect(f.calls).toHaveLength(2);
    f.respond(json(fixture));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(3);
    f.respond(json(fixture));
    expect((await Promise.all(results)).every((r) => r?.category === 'win')).toBe(true);
    expect(c.requestCount()).toBe(3);
  });

  it('shares one request between callers of the same FEN', async () => {
    const f = controlledFetch();
    const c = createLichessTablebase({ fetch: f.fetch });
    const a = c.probe(FEN);
    const b = c.probe(` ${FEN} `);
    await vi.advanceTimersByTimeAsync(0);
    f.respond(json(fixture));
    expect((await a)?.category).toBe('win');
    expect((await b)?.category).toBe('win');
    expect(f.calls).toHaveLength(1);
  });

  it('429: honours Retry-After, answers null meanwhile without a request, then recovers', async () => {
    const f = controlledFetch();
    const c = createLichessTablebase({ fetch: f.fetch });
    const first = c.probe(FEN);
    const queued = c.probe(FEN2);
    await vi.advanceTimersByTimeAsync(0);
    f.respond(json({ error: 'slow down' }, 429, { 'Retry-After': '5' }));
    expect(await first).toBeNull();
    expect(await queued).toBeNull(); // flushed, never sent
    expect(c.available()).toBe(false);
    expect(c.blockedReason()).toBe('rate_limited');
    expect(c.blockedUntil()).toBe(Date.now() + 5000);
    expect(await c.probe(FEN3)).toBeNull();
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.available()).toBe(true);
    const again = c.probe(FEN);
    await vi.advanceTimersByTimeAsync(0);
    f.respond(json(fixture));
    expect((await again)?.category).toBe('win');
  });

  it('429 without Retry-After waits 60 s', async () => {
    const f = controlledFetch();
    const c = createLichessTablebase({ fetch: f.fetch });
    const p = c.probe(FEN);
    await vi.advanceTimersByTimeAsync(0);
    f.respond(new Response('', { status: 429 }));
    expect(await p).toBeNull();
    expect(c.blockedUntil()).toBe(Date.now() + 60_000);
  });

  it.each([
    [
      'a 5xx answer',
      (f: ReturnType<typeof controlledFetch>) => f.respond(new Response('', { status: 503 })),
    ],
    ['a network error', (f: ReturnType<typeof controlledFetch>) => f.fail()],
  ])('%s makes the source unavailable for 60 s', async (_label, act) => {
    const f = controlledFetch();
    const c = createLichessTablebase({ fetch: f.fetch });
    const p = c.probe(FEN);
    await vi.advanceTimersByTimeAsync(0);
    act(f);
    expect(await p).toBeNull();
    expect(c.blockedReason()).toBe('unavailable');
    expect(c.blockedUntil()).toBe(Date.now() + COOLDOWN_MS);
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS - 1);
    expect(c.available()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.available()).toBe(true);
  });

  it('times out after 10 s and cools down', async () => {
    const f = controlledFetch();
    const c = createLichessTablebase({ fetch: f.fetch });
    const p = c.probe(FEN);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(f.calls[0]!.init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls[0]!.init.signal?.aborted).toBe(true);
    expect(await p).toBeNull();
    expect(c.blockedReason()).toBe('unavailable');
  });

  it('drops inexact and invalid answers and 4xx without a cooldown', async () => {
    const f = controlledFetch();
    const c = createLichessTablebase({ fetch: f.fetch, spacingMs: 0 });
    const inexact = c.probe(FEN);
    await vi.advanceTimersByTimeAsync(0);
    f.respond(json({ ...fixture, category: 'maybe-win' }));
    expect(await inexact).toBeNull();
    const invalid = c.probe(FEN2);
    await vi.advanceTimersByTimeAsync(0);
    f.respond(new Response('<html>', { status: 200 }));
    expect(await invalid).toBeNull();
    const bad = c.probe(FEN3);
    await vi.advanceTimersByTimeAsync(0);
    f.respond(new Response('invalid fen', { status: 400 }));
    expect(await bad).toBeNull();
    expect(c.available()).toBe(true);
  });

  it('abort while queued: AbortError, never sent', async () => {
    const f = controlledFetch();
    const c = createLichessTablebase({ fetch: f.fetch });
    const first = c.probe(FEN);
    const ctl = new AbortController();
    const second = c.probe(FEN2, { signal: ctl.signal });
    await vi.advanceTimersByTimeAsync(0);
    ctl.abort();
    await expect(second).rejects.toSatisfy(isAbortError);
    f.respond(json(fixture));
    await first;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.calls).toHaveLength(1);
    expect(c.available()).toBe(true);
  });

  it('abort in flight cancels the request without a cooldown', async () => {
    const f = controlledFetch();
    const c = createLichessTablebase({ fetch: f.fetch });
    const ctl = new AbortController();
    const p = c.probe(FEN, { signal: ctl.signal });
    await vi.advanceTimersByTimeAsync(0);
    ctl.abort();
    await expect(p).rejects.toSatisfy(isAbortError);
    expect(f.calls[0]!.init.signal?.aborted).toBe(true);
    expect(c.available()).toBe(true);
    await expect(c.probe(FEN, { signal: ctl.signal })).rejects.toSatisfy(isAbortError);
  });

  it('a shared request survives while another caller still waits', async () => {
    const f = controlledFetch();
    const c = createLichessTablebase({ fetch: f.fetch });
    const ctl = new AbortController();
    const a = c.probe(FEN, { signal: ctl.signal });
    const b = c.probe(FEN);
    await vi.advanceTimersByTimeAsync(0);
    ctl.abort();
    await expect(a).rejects.toSatisfy(isAbortError);
    expect(f.calls[0]!.init.signal?.aborted).toBe(false);
    f.respond(json(fixture));
    expect((await b)?.category).toBe('win');
  });

  it('abortAll rejects queued and running probes', async () => {
    const f = controlledFetch();
    const c = createLichessTablebase({ fetch: f.fetch });
    const a = c.probe(FEN);
    const b = c.probe(FEN2);
    await vi.advanceTimersByTimeAsync(0);
    c.abortAll();
    await expect(a).rejects.toSatisfy(isAbortError);
    await expect(b).rejects.toSatisfy(isAbortError);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.calls).toHaveLength(1);
    // Still usable afterwards.
    const again = c.probe(FEN3);
    await vi.advanceTimersByTimeAsync(0);
    f.respond(json(fixture));
    expect((await again)?.category).toBe('win');
  });
});
