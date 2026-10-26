import { describe, expect, it, vi } from 'vitest';
import { AUTH_STORAGE_KEY, lichessFetch, resetLichessAuth } from '../lichess/auth';
import {
  OnlineImportError,
  fetchChessComGames,
  fetchChessComPage,
  fetchLichessGames,
  fetchLichessPage,
  fetchLichessPgn,
  fetchOnlineGamePgn,
  fetchOnlineGames,
  normalizeUsername,
  type FetchLike,
} from './index';

const res = (body: string, status = 200) => new Response(body, { status });
const mock = (...rs: Response[]) => {
  const fn = vi.fn<FetchLike>();
  for (const r of rs) fn.mockResolvedValueOnce(r);
  return fn;
};
const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof OnlineImportError ? e.kind : 'other';
  }
  return 'none';
};

const LI_1 = {
  id: 'abc12345',
  speed: 'blitz',
  createdAt: 1700000000000,
  status: 'mate',
  winner: 'white',
  players: {
    white: { user: { name: 'Alice', id: 'alice' }, rating: 1800 },
    black: { user: { name: 'Bob', id: 'bob' }, rating: 1750 },
  },
  opening: { eco: 'C20', name: "King's Pawn Game" },
  clock: { initial: 180, increment: 2, totalTime: 260 },
};
const LI_2 = {
  id: 'def67890',
  speed: 'rapid',
  createdAt: 1699990000000,
  status: 'draw',
  players: { white: { aiLevel: 3 }, black: { user: { name: 'Alice' }, rating: 1801 } },
  clock: { initial: 900, increment: 10 },
};
const ndjson = [LI_1, LI_2].map((g) => JSON.stringify(g)).join('\n') + '\n';

const pageOf = (n: number, from = 1700000000000) =>
  Array.from({ length: n }, (_, i) =>
    JSON.stringify({ ...LI_1, id: `g${from}-${i}`, createdAt: from - i * 1000 }),
  ).join('\n');

describe('lichess paging, rate limits and PGN in the stream', () => {
  it('uses the PGN from the ndjson and falls back to pgnUrl without it', async () => {
    const withPgn = JSON.stringify({ ...LI_1, pgn: '[White "Alice"]\n\n1. e4 *' });
    const games = await fetchLichessGames('Alice', {
      fetch: mock(res(`${withPgn}\n${JSON.stringify(LI_2)}\n`)),
    });
    expect(games[0]?.pgn).toContain('1. e4');
    expect(games[0]?.pgnUrl).toBeUndefined();
    expect(games[1]?.pgn).toBeUndefined();
    expect(games[1]?.pgnUrl).toContain('/game/export/def67890');
    const f = vi.fn<FetchLike>();
    expect(await fetchOnlineGamePgn(games[0]!, { fetch: f })).toContain('1. e4');
    expect(f).not.toHaveBeenCalled();
  });

  it('pages with until = oldest createdAt - 1 and stops on a short page', async () => {
    const f = mock(res(pageOf(3)), res(pageOf(2, 1699000000000)));
    const p1 = await fetchLichessPage('Alice', { fetch: f, max: 3 });
    expect(p1.next).toBe(String(1700000000000 - 2000 - 1));
    const p2 = await fetchLichessPage('Alice', { fetch: f, max: 3, cursor: p1.next });
    expect(f.mock.calls[1]?.[0]).toContain(`&until=${p1.next}`);
    expect(f.mock.calls[0]?.[0]).not.toContain('until=');
    expect(p2.games).toHaveLength(2);
    expect(p2.next).toBeUndefined();
  });

  it('maps 429 to a rate-limit message honouring Retry-After (at least a minute) and fails fast afterwards', async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '150' } }));
    await expect(fetchLichessGames('Alice', { fetch: f })).rejects.toThrow(/rate limit.*3 minutes/);
    await expect(fetchLichessGames('Alice', { fetch: f })).rejects.toMatchObject({
      kind: 'rate-limited',
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('maps a TypeError right after a successful request (CORS-less 429) to rate-limited, not "check your connection"', async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(res(ndjson))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await fetchLichessGames('Alice', { fetch: f });
    const err = await fetchLichessPgn(
      {
        id: 'x',
        site: 'lichess',
        white: { name: 'a' },
        black: { name: 'b' },
        result: '*',
        date: '',
      },
      { fetch: f },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate-limited' });
    expect((err as Error).message).toMatch(/rate limit/);
    expect((err as Error).message).not.toMatch(/connection/);
  });

  it('runs requests one at a time', async () => {
    let active = 0;
    let peak = 0;
    const f: FetchLike = async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return res(ndjson);
    };
    await Promise.all([
      fetchLichessGames('Alice', { fetch: f }),
      fetchLichessGames('Bob1', { fetch: f }),
      fetchLichessGames('Cy1', { fetch: f }),
    ]);
    expect(peak).toBe(1);
  });
});

describe('lichess client', () => {
  it('parses NDJSON and sends the right request', async () => {
    const f = mock(res(ndjson));
    const games = await fetchLichessGames('Alice', { fetch: f });
    expect(f).toHaveBeenCalledWith(
      'https://lichess.org/api/games/user/Alice?max=20&pgnInJson=true&clocks=true&evals=false&opening=true',
      { headers: { Accept: 'application/x-ndjson' } },
    );
    expect(games).toHaveLength(2);
    expect(games[0]).toMatchObject({
      id: 'abc12345',
      site: 'lichess',
      white: { name: 'Alice', rating: 1800 },
      black: { name: 'Bob', rating: 1750 },
      result: '1-0',
      date: '2023-11-14T22:13:20.000Z',
      speed: 'blitz',
      timeControl: '3+2',
      opening: "King's Pawn Game",
    });
    expect(games[0]?.pgnUrl).toBe(
      'https://lichess.org/game/export/abc12345?clocks=true&evals=false',
    );
    expect(games[1]).toMatchObject({
      white: { name: 'Stockfish level 3' },
      result: '1/2-1/2',
      timeControl: '15+10',
    });
  });

  it('maps 404, 429, 500, network errors and malformed JSON', async () => {
    expect(await kindOf(fetchLichessGames('x1', { fetch: mock(res('', 404)) }))).toBe('not-found');
    const limited = fetchLichessGames('x1', { fetch: mock(res('', 429)) });
    await expect(limited).rejects.toThrow(/try again in a minute/);
    expect(await kindOf(fetchLichessGames('x1', { fetch: mock(res('', 500)) }))).toBe(
      'bad-response',
    );
    const down = vi.fn<FetchLike>().mockRejectedValue(new TypeError('fail'));
    expect(await kindOf(fetchLichessGames('x1', { fetch: down }))).toBe('network');
    expect(await kindOf(fetchLichessGames('x1', { fetch: mock(res('{nope')) }))).toBe(
      'bad-response',
    );
  });

  it('fetches a PGN', async () => {
    const f = mock(res('[White "A"]\n\n1. e4 *'));
    const [g] = await fetchLichessGames('Alice', { fetch: mock(res(ndjson)) });
    const pgn = await fetchLichessPgn(g!, { fetch: f });
    expect(pgn).toContain('1. e4');
    expect(f.mock.calls[0]?.[1]).toEqual({ headers: { Accept: 'application/x-chess-pgn' } });
  });
});

const cc = (over: Record<string, unknown>) => ({
  url: 'https://www.chess.com/game/live/1',
  pgn: '[White "a"]\n\n1. e4 e5 *',
  end_time: 1700000000,
  time_class: 'blitz',
  time_control: '180+2',
  eco: 'https://www.chess.com/openings/Kings-Indian-Defense-Fianchetto-8.d5-Nb8',
  white: { username: 'Hikaru', rating: 3000, result: 'win' },
  black: { username: 'other', rating: 2800, result: 'resigned' },
  ...over,
});

describe('chess.com client', () => {
  const archives = JSON.stringify({
    archives: [
      'https://api.chess.com/pub/player/hikaru/games/2023/09',
      'https://api.chess.com/pub/player/hikaru/games/2023/10',
      'https://api.chess.com/pub/player/hikaru/games/2023/11',
    ],
  });

  it('walks the months newest first until max is reached, and maps fields', async () => {
    const nov = JSON.stringify({
      games: [
        cc({ url: 'https://www.chess.com/game/live/1', end_time: 1700000000 }),
        cc({
          url: 'https://www.chess.com/game/live/2',
          end_time: 1700001000,
          white: { username: 'x', rating: 1, result: 'repetition' },
          black: { username: 'Hikaru', result: 'repetition' },
          time_control: '1/86400',
        }),
      ],
    });
    const oct = JSON.stringify({
      games: [
        cc({
          url: 'https://www.chess.com/game/live/0',
          end_time: 1698000000,
          white: { username: 'a', result: 'checkmated' },
          black: { username: 'b', result: 'win' },
        }),
      ],
    });
    const f = mock(res(archives), res(nov), res(oct), res('{"games":[]}'));
    const games = await fetchChessComGames('Hikaru', { fetch: f });
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      'https://api.chess.com/pub/player/hikaru/games/archives',
      'https://api.chess.com/pub/player/hikaru/games/2023/11',
      'https://api.chess.com/pub/player/hikaru/games/2023/10',
      'https://api.chess.com/pub/player/hikaru/games/2023/09',
    ]);
    expect(games.map((g) => g.id)).toEqual(['2', '1', '0']);
    expect(games[1]).toMatchObject({
      site: 'chesscom',
      white: { name: 'Hikaru', rating: 3000 },
      result: '1-0',
      speed: 'blitz',
      timeControl: '3+2',
      opening: 'Kings Indian Defense Fianchetto',
    });
    expect(games[1]?.pgn).toContain('1. e4');
    expect(games[0]).toMatchObject({ result: '1/2-1/2', timeControl: '1d' });
    expect(games[2]?.result).toBe('0-1');
  });

  it('caps the list at max', async () => {
    const many = JSON.stringify({
      games: Array.from({ length: 30 }, (_, i) => cc({ url: `u/${i}` })),
    });
    const games = await fetchChessComGames('hikaru', {
      fetch: mock(res(archives), res(many)),
      max: 5,
    });
    expect(games).toHaveLength(5);
  });

  const month = (ym: string, n: number, base: number) =>
    JSON.stringify({
      games: Array.from({ length: n }, (_, i) =>
        cc({ url: `https://www.chess.com/game/live/${ym}-${i}`, end_time: base + i }),
      ),
    });
  const manyArchives = (n: number) =>
    JSON.stringify({
      archives: Array.from(
        { length: n },
        (_, i) =>
          `https://api.chess.com/pub/player/hikaru/games/${2020 + Math.floor(i / 12)}/${String((i % 12) + 1).padStart(2, '0')}`,
      ),
    });

  it('walks archives backwards past empty months until max games, then pages on', async () => {
    const f = mock(
      res(manyArchives(5)),
      res(month('5', 1, 500)),
      res('{"games":[]}'),
      res('{"games":[]}'),
      res(month('2', 3, 200)),
    );
    const page = await fetchChessComPage('hikaru', { fetch: f, max: 3 });
    expect(page.games.map((g) => g.id)).toEqual(['5-0', '2-2', '2-1']);
    expect(page.next).toBe('https://api.chess.com/pub/player/hikaru/games/2020/02#2');
    const f2 = mock(res(manyArchives(5)), res(month('2', 3, 200)), res(month('1', 2, 100)));
    const p2 = await fetchChessComPage('hikaru', { fetch: f2, max: 3, cursor: page.next });
    expect(p2.games.map((g) => g.id)).toEqual(['2-0', '1-1', '1-0']);
    expect(p2.next).toBeUndefined();
    expect(f2.mock.calls[1]?.[0]).toMatch(/2020\/02$/);
  });

  it('limits archive requests per call and continues from the next older archive', async () => {
    const f = vi
      .fn<FetchLike>()
      .mockImplementation(async (u) =>
        res(u.endsWith('/archives') ? manyArchives(30) : '{"games":[]}'),
      );
    const page = await fetchChessComPage('hikaru', { fetch: f });
    expect(f).toHaveBeenCalledTimes(1 + 12);
    expect(page.games).toEqual([]);
    expect(page.next).toMatch(/#0$/);
  });

  it('returns an empty list without archives', async () => {
    expect(await fetchChessComGames('hikaru', { fetch: mock(res('{"archives":[]}')) })).toEqual([]);
  });

  it('maps 404, 429, network errors and malformed JSON', async () => {
    expect(await kindOf(fetchChessComGames('nobody', { fetch: mock(res('', 404)) }))).toBe(
      'not-found',
    );
    expect(await kindOf(fetchChessComGames('nobody', { fetch: mock(res('', 429)) }))).toBe(
      'rate-limited',
    );
    const down = vi.fn<FetchLike>().mockRejectedValue(new TypeError('fail'));
    expect(await kindOf(fetchChessComGames('nobody', { fetch: down }))).toBe('network');
    expect(await kindOf(fetchChessComGames('nobody', { fetch: mock(res('<html>')) }))).toBe(
      'bad-response',
    );
    expect(
      await kindOf(fetchChessComGames('hikaru', { fetch: mock(res(archives), res('garbage')) })),
    ).toBe('bad-response');
  });
});

describe('facade', () => {
  it('normalizes usernames', () => {
    expect(normalizeUsername('  Magnus_1-x ')).toBe('Magnus_1-x');
    expect(normalizeUsername('a')).toBeNull();
    expect(normalizeUsername('bad name')).toBeNull();
    expect(normalizeUsername('x'.repeat(31))).toBeNull();
    expect(normalizeUsername('a/../b')).toBeNull();
  });

  it('rejects invalid usernames without fetching', async () => {
    const f = vi.fn<FetchLike>();
    expect(await kindOf(fetchOnlineGames('lichess', 'a b', { fetch: f }))).toBe('invalid-username');
    expect(f).not.toHaveBeenCalled();
  });

  it('dispatches by site with the trimmed name', async () => {
    const f = mock(res(ndjson));
    await fetchOnlineGames('lichess', ' Alice ', { fetch: f });
    expect(f.mock.calls[0]?.[0]).toContain('/api/games/user/Alice?');
    const g = mock(res('{"archives":[]}'));
    await fetchOnlineGames('chesscom', 'Alice', { fetch: g });
    expect(g.mock.calls[0]?.[0]).toBe('https://api.chess.com/pub/player/alice/games/archives');
  });

  it('returns inline PGN without fetching, else fetches', async () => {
    const f = vi.fn<FetchLike>();
    const base = {
      id: '1',
      site: 'chesscom',
      white: { name: 'a' },
      black: { name: 'b' },
      result: '*',
      date: '',
    } as const;
    expect(await fetchOnlineGamePgn({ ...base, pgn: '1. e4 *' }, { fetch: f })).toBe('1. e4 *');
    expect(f).not.toHaveBeenCalled();
    const g = mock(res('1. d4 *'));
    expect(
      await fetchOnlineGamePgn(
        { ...base, site: 'lichess', pgnUrl: 'https://lichess.org/game/export/1' },
        { fetch: g },
      ),
    ).toBe('1. d4 *');
  });
});

describe('lichess with the login', () => {
  it('sends the Authorization header through lichessFetch', async () => {
    const store = new Map<string, string>([
      [AUTH_STORAGE_KEY, JSON.stringify({ token: 'lio_x', username: 'Alice', scopes: [] })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: () => {},
      removeItem: () => {},
    });
    resetLichessAuth();
    const fetchMock = vi.fn(async () => res(`${JSON.stringify(LI_1)}\n`));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const games = await fetchLichessGames('Alice', { fetch: lichessFetch });
      expect(games).toHaveLength(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain('https://lichess.org/api/games/user/Alice');
      expect(url).not.toContain('lio_x');
      const h = new Headers(init.headers);
      expect(h.get('Authorization')).toBe('Bearer lio_x');
      expect(h.get('Accept')).toBe('application/x-ndjson');
    } finally {
      vi.unstubAllGlobals();
      resetLichessAuth();
    }
  });
});

describe('clock times in imported games (M22-1)', () => {
  it('requests lichess PGNs with clocks and without evals, also without a listed pgnUrl', async () => {
    const f = mock(res('1. e4 { [%clk 0:03:00] } *'));
    const game = {
      id: 'abc 1',
      site: 'lichess',
      white: { name: 'a' },
      black: { name: 'b' },
      result: '*',
      date: '',
    } as const;
    await fetchLichessPgn(game, { fetch: f });
    expect(f.mock.calls[0]?.[0]).toBe(
      'https://lichess.org/game/export/abc%201?clocks=true&evals=false',
    );
  });

  it('keeps the %clk comments of chess.com PGNs untouched', async () => {
    const pgn =
      '[Event "Live Chess"]\n[TimeControl "180+2"]\n\n1. e4 {[%clk 0:02:59.9]} 1... e5 {[%clk 0:02:58.2]} *';
    const archives = JSON.stringify({
      archives: ['https://api.chess.com/pub/player/ann/games/2026/10'],
    });
    const month = JSON.stringify({ games: [cc({ pgn })] });
    const [g] = await fetchChessComGames('ann', { fetch: mock(res(archives), res(month)) });
    const text = await fetchOnlineGamePgn(g!, { fetch: vi.fn<FetchLike>() });
    expect(text).toContain('{[%clk 0:02:59.9]}');
    expect(text).toContain('[TimeControl "180+2"]');
  });
});
