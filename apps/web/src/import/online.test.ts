import { describe, expect, it, vi } from 'vitest';
import {
  OnlineImportError,
  fetchChessComGames,
  fetchLichessGames,
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
  opening: { eco: 'C20', name: 'King\'s Pawn Game' },
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

describe('lichess client', () => {
  it('parses NDJSON and sends the right request', async () => {
    const f = mock(res(ndjson));
    const games = await fetchLichessGames('Alice', { fetch: f });
    expect(f).toHaveBeenCalledWith(
      'https://lichess.org/api/games/user/Alice?max=20&pgnInJson=false&clocks=false&evals=false&opening=true',
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
    expect(games[0]?.pgnUrl).toBe('https://lichess.org/game/export/abc12345?clocks=false&evals=false');
    expect(games[1]).toMatchObject({ white: { name: 'Stockfish level 3' }, result: '1/2-1/2', timeControl: '15+10' });
  });

  it('maps 404, 429, 500, network errors and malformed JSON', async () => {
    expect(await kindOf(fetchLichessGames('x1', { fetch: mock(res('', 404)) }))).toBe('not-found');
    const limited = fetchLichessGames('x1', { fetch: mock(res('', 429)) });
    await expect(limited).rejects.toThrow(/try again in a minute/);
    expect(await kindOf(fetchLichessGames('x1', { fetch: mock(res('', 500)) }))).toBe('bad-response');
    const down = vi.fn<FetchLike>().mockRejectedValue(new TypeError('fail'));
    expect(await kindOf(fetchLichessGames('x1', { fetch: down }))).toBe('network');
    expect(await kindOf(fetchLichessGames('x1', { fetch: mock(res('{nope')) }))).toBe('bad-response');
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

  it('takes the latest months, newest first, and maps fields', async () => {
    const nov = JSON.stringify({
      games: [cc({ url: 'https://www.chess.com/game/live/1', end_time: 1700000000 }),
        cc({ url: 'https://www.chess.com/game/live/2', end_time: 1700001000, white: { username: 'x', rating: 1, result: 'repetition' }, black: { username: 'Hikaru', result: 'repetition' }, time_control: '1/86400' })],
    });
    const oct = JSON.stringify({ games: [cc({ url: 'https://www.chess.com/game/live/0', end_time: 1698000000, white: { username: 'a', result: 'checkmated' }, black: { username: 'b', result: 'win' } })] });
    const f = mock(res(archives), res(nov), res(oct));
    const games = await fetchChessComGames('Hikaru', { fetch: f });
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      'https://api.chess.com/pub/player/hikaru/games/archives',
      'https://api.chess.com/pub/player/hikaru/games/2023/11',
      'https://api.chess.com/pub/player/hikaru/games/2023/10',
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
    const many = JSON.stringify({ games: Array.from({ length: 30 }, (_, i) => cc({ url: `u/${i}` })) });
    const games = await fetchChessComGames('hikaru', { fetch: mock(res(archives), res(many)), max: 5 });
    expect(games).toHaveLength(5);
  });

  it('returns an empty list without archives', async () => {
    expect(await fetchChessComGames('hikaru', { fetch: mock(res('{"archives":[]}')) })).toEqual([]);
  });

  it('maps 404, 429, network errors and malformed JSON', async () => {
    expect(await kindOf(fetchChessComGames('nobody', { fetch: mock(res('', 404)) }))).toBe('not-found');
    expect(await kindOf(fetchChessComGames('nobody', { fetch: mock(res('', 429)) }))).toBe('rate-limited');
    const down = vi.fn<FetchLike>().mockRejectedValue(new TypeError('fail'));
    expect(await kindOf(fetchChessComGames('nobody', { fetch: down }))).toBe('network');
    expect(await kindOf(fetchChessComGames('nobody', { fetch: mock(res('<html>')) }))).toBe('bad-response');
    expect(await kindOf(fetchChessComGames('hikaru', { fetch: mock(res(archives), res('garbage')) }))).toBe('bad-response');
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
    const base = { id: '1', site: 'chesscom', white: { name: 'a' }, black: { name: 'b' }, result: '*', date: '' } as const;
    expect(await fetchOnlineGamePgn({ ...base, pgn: '1. e4 *' }, { fetch: f })).toBe('1. e4 *');
    expect(f).not.toHaveBeenCalled();
    const g = mock(res('1. d4 *'));
    expect(await fetchOnlineGamePgn({ ...base, site: 'lichess', pgnUrl: 'https://lichess.org/game/export/1' }, { fetch: g })).toBe('1. d4 *');
  });
});
