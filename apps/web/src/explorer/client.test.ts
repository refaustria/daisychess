import { describe, expect, it, vi } from 'vitest';
import {
  buildExplorerUrl,
  DEFAULT_RETRY_AFTER,
  ExplorerError,
  fetchExplorer,
  fetchExplorerGamePgn,
  parseExplorerResult,
  queryKey,
  type ExplorerFetch,
} from './client';
import { EMPTY, htmlResponse, jsonResponse, LICHESS_E4, MASTERS_PGN, MASTERS_START } from './fixtures';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const fetchReturning = (res: Response | (() => Response)) =>
  vi.fn<ExplorerFetch>(async () => (typeof res === 'function' ? res() : res));

async function rejection(p: Promise<unknown>): Promise<ExplorerError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExplorerError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
}

describe('buildExplorerUrl', () => {
  it('masters: fen, play, topGames; no lichess filters', () => {
    const url = new URL(
      buildExplorerUrl({ db: 'masters', fen: START, play: ['e2e4', 'e7e5'], speeds: ['blitz'], ratings: [2000] }),
    );
    expect(url.origin + url.pathname).toBe('https://explorer.lichess.org/masters');
    expect(url.searchParams.get('fen')).toBe(START);
    expect(url.searchParams.get('play')).toBe('e2e4,e7e5');
    expect(url.searchParams.get('topGames')).toBe('10');
    expect(url.searchParams.has('speeds')).toBe(false);
    expect(url.searchParams.has('ratings')).toBe(false);
  });

  it('lichess: variant, filters, recentGames; no play when empty', () => {
    const url = new URL(
      buildExplorerUrl({ db: 'lichess', fen: START, play: [], speeds: ['blitz', 'rapid'], ratings: [1600, 1800] }),
    );
    expect(url.pathname).toBe('/lichess');
    expect(url.searchParams.get('variant')).toBe('standard');
    expect(url.searchParams.get('speeds')).toBe('blitz,rapid');
    expect(url.searchParams.get('ratings')).toBe('1600,1800');
    expect(url.searchParams.get('recentGames')).toBe('4');
    expect(url.searchParams.has('play')).toBe(false);
  });

  it('never puts a token in the URL; key differs per db and filters', () => {
    const a = queryKey({ db: 'lichess', fen: START, play: [], ratings: [1600] });
    const b = queryKey({ db: 'lichess', fen: START, play: [], ratings: [1800] });
    const c = queryKey({ db: 'masters', fen: START, play: [] });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).not.toMatch(/token|lip_/i);
  });
});

describe('parseExplorerResult', () => {
  it('normalises masters', () => {
    const r = parseExplorerResult(MASTERS_START);
    expect(r.white + r.draws + r.black).toBe(3000);
    expect(r.moves.map((m) => m.san)).toEqual(['e4', 'd4', 'Nf3']);
    expect(r.topGames[0]).toMatchObject({ id: 'mAsTer01', winner: 'white', year: 2019, month: '2019-06' });
    expect(r.topGames[1]?.winner).toBeNull();
    expect(r.recentGames).toEqual([]);
    expect(r.opening).toBeNull();
  });

  it('normalises lichess (opening, recentGames, speed)', () => {
    const r = parseExplorerResult(LICHESS_E4);
    expect(r.opening).toEqual({ eco: 'B00', name: "King's Pawn" });
    expect(r.recentGames[0]).toMatchObject({ id: 'liGame01', speed: 'blitz', winner: 'black' });
    expect(r.recentGames[0]?.white).toEqual({ name: 'alice', rating: 1800 });
  });

  it('accepts an empty position', () => {
    expect(parseExplorerResult(EMPTY).moves).toEqual([]);
  });

  it('skips malformed games, rejects malformed bodies', () => {
    const r = parseExplorerResult({ ...EMPTY, topGames: [{ nope: 1 }, MASTERS_START.topGames[0]] });
    expect(r.topGames).toHaveLength(1);
    expect(() => parseExplorerResult(null)).toThrow(ExplorerError);
    expect(() => parseExplorerResult({ white: 1, draws: 0, black: 0 })).toThrow(/Unexpected/);
    expect(() => parseExplorerResult({ ...EMPTY, white: -1 })).toThrow(ExplorerError);
    expect(() => parseExplorerResult({ ...EMPTY, moves: [{ uci: 'e2e4' }] })).toThrow(ExplorerError);
  });
});

describe('fetchExplorer', () => {
  const q = { db: 'masters' as const, fen: START, play: [] };

  it('sends Accept and the token as a Bearer header only', async () => {
    const f = fetchReturning(jsonResponse(MASTERS_START));
    const r = await fetchExplorer(q, { fetch: f, token: ' lip_secret ' });
    expect(r.moves).toHaveLength(3);
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).not.toContain('lip_secret');
    expect(init?.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer lip_secret' });
  });

  it('omits Authorization without a token', async () => {
    const f = fetchReturning(jsonResponse(MASTERS_START));
    await fetchExplorer(q, { fetch: f });
    expect(f.mock.calls[0]?.[1].headers).toEqual({ Accept: 'application/json' });
  });

  it('401 (nginx HTML) → unauthorized', async () => {
    const e = await rejection(fetchExplorer(q, { fetch: fetchReturning(htmlResponse(401)) }));
    expect(e.kind).toBe('unauthorized');
    expect(e.status).toBe(401);
    expect(e.message).toMatch(/requires a lichess API token/);
    const e2 = await rejection(fetchExplorer(q, { fetch: fetchReturning(htmlResponse(403)), token: 'x' }));
    expect(e2.kind).toBe('unauthorized');
    expect(e2.message).toMatch(/rejected/);
  });

  it('429 → rate_limited with Retry-After (seconds or date) or the default', async () => {
    let e = await rejection(fetchExplorer(q, { fetch: fetchReturning(htmlResponse(429, { 'Retry-After': '17' })) }));
    expect(e).toMatchObject({ kind: 'rate_limited', retryAfter: 17 });
    expect(e.message).toContain('17 s');
    const at = new Date(Date.now() + 30_000).toUTCString();
    e = await rejection(fetchExplorer(q, { fetch: fetchReturning(htmlResponse(429, { 'Retry-After': at })) }));
    expect(e.retryAfter).toBeGreaterThanOrEqual(28);
    expect(e.retryAfter).toBeLessThanOrEqual(31);
    e = await rejection(fetchExplorer(q, { fetch: fetchReturning(htmlResponse(429)) }));
    expect(e.retryAfter).toBe(DEFAULT_RETRY_AFTER);
  });

  it('network failure → network; 5xx and non-JSON → bad_response', async () => {
    const down = vi.fn<ExplorerFetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await rejection(fetchExplorer(q, { fetch: down }))).kind).toBe('network');
    expect((await rejection(fetchExplorer(q, { fetch: fetchReturning(htmlResponse(502)) }))).kind).toBe(
      'bad_response',
    );
    expect((await rejection(fetchExplorer(q, { fetch: fetchReturning(htmlResponse(200)) }))).kind).toBe(
      'bad_response',
    );
  });

  it('propagates aborts unchanged and passes the signal', async () => {
    const ctrl = new AbortController();
    const f = vi.fn<ExplorerFetch>(
      (_u, init) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
    );
    const p = fetchExplorer(q, { fetch: f, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('fetchExplorerGamePgn', () => {
  it('masters: explorer /masters/pgn with the token', async () => {
    const f = fetchReturning(() => new Response(MASTERS_PGN));
    expect(await fetchExplorerGamePgn('masters', 'mAsTer01', { fetch: f, token: 'tok' })).toBe(MASTERS_PGN);
    expect(f.mock.calls[0]?.[0]).toBe('https://explorer.lichess.org/masters/pgn/mAsTer01');
    expect(f.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer tok');
  });

  it('lichess: lichess.org export, token not forwarded to lichess.org', async () => {
    const f = fetchReturning(() => new Response(MASTERS_PGN));
    await fetchExplorerGamePgn('lichess', 'liGame01', { fetch: f, token: 'tok' });
    expect(f.mock.calls[0]?.[0]).toBe('https://lichess.org/game/export/liGame01?clocks=false&evals=false');
    expect(f.mock.calls[0]?.[1].headers.Authorization).toBeUndefined();
  });

  it('empty body → bad_response; 404 → not_found', async () => {
    expect((await rejection(fetchExplorerGamePgn('lichess', 'x', { fetch: fetchReturning(new Response(' ')) }))).kind).toBe(
      'bad_response',
    );
    expect(
      (await rejection(fetchExplorerGamePgn('lichess', 'x', { fetch: fetchReturning(new Response('', { status: 404 })) })))
        .kind,
    ).toBe('not_found');
  });
});
