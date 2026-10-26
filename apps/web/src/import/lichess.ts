import {
  OnlineImportError,
  defaultFetch,
  request,
  type FetchOptions,
  type OnlineGame,
  type OnlinePage,
  type OnlinePlayer,
} from './types';

interface LichessPlayer {
  user?: { name?: string; id?: string };
  aiLevel?: number;
  rating?: number;
}

interface LichessGame {
  id?: unknown;
  pgn?: unknown;
  speed?: unknown;
  createdAt?: unknown;
  status?: unknown;
  winner?: unknown;
  players?: { white?: LichessPlayer; black?: LichessPlayer };
  opening?: { name?: string };
  clock?: { initial?: number; increment?: number };
}

const GAME_URL = 'https://lichess.org/game/export/';

function player(p: LichessPlayer | undefined): OnlinePlayer {
  const name =
    p?.user?.name ?? (p?.aiLevel !== undefined ? `Stockfish level ${p.aiLevel}` : 'Anonymous');
  return p?.rating !== undefined ? { name, rating: p.rating } : { name };
}

function resultOf(g: LichessGame): OnlineGame['result'] {
  if (g.winner === 'white') return '1-0';
  if (g.winner === 'black') return '0-1';
  if (g.status === 'draw' || g.status === 'stalemate') return '1/2-1/2';
  return '*';
}

function mapGame(raw: unknown): OnlineGame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const g = raw as LichessGame;
  if (typeof g.id !== 'string' || typeof g.createdAt !== 'number') return null;
  const game: OnlineGame = {
    id: g.id,
    site: 'lichess',
    white: player(g.players?.white),
    black: player(g.players?.black),
    result: resultOf(g),
    date: new Date(g.createdAt).toISOString(),
  };
  // With pgnInJson the listing carries the PGN, so opening a game needs no extra request.
  if (typeof g.pgn === 'string' && g.pgn.trim()) game.pgn = g.pgn;
  else game.pgnUrl = `${GAME_URL}${g.id}?clocks=true&evals=false`;
  if (typeof g.speed === 'string') game.speed = g.speed;
  if (g.clock && typeof g.clock.initial === 'number') {
    const min = g.clock.initial / 60;
    game.timeControl = `${Number.isInteger(min) ? min : min.toFixed(2).replace(/0+$/, '')}+${g.clock.increment ?? 0}`;
  }
  if (g.opening?.name) game.opening = g.opening.name;
  return game;
}

/**
 * One page of a lichess user's games, newest first, as one ndjson stream with the PGN of every game
 * included (no per-game export request later). Cursor = `until` in ms (createdAt of the oldest listed game - 1).
 */
export async function fetchLichessPage(
  username: string,
  opts: FetchOptions = {},
): Promise<OnlinePage> {
  const max = opts.max ?? 20;
  const doFetch = opts.fetch ?? defaultFetch;
  const until = opts.cursor && /^\d+$/.test(opts.cursor) ? `&until=${opts.cursor}` : '';
  const url =
    `https://lichess.org/api/games/user/${encodeURIComponent(username)}` +
    `?max=${max}&pgnInJson=true&clocks=true&evals=false&opening=true${until}`;
  const res = await request('lichess', url, 'application/x-ndjson', doFetch, `User "${username}"`);
  const text = await res.text();
  const games: OnlineGame[] = [];
  let oldest = Infinity;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new OnlineImportError('bad-response', 'Unexpected response from lichess');
    }
    const g = mapGame(parsed);
    if (g) {
      games.push(g);
      oldest = Math.min(oldest, Date.parse(g.date));
    }
  }
  const page = games.slice(0, max);
  // A full page means there may be more; a short one is the end of the history.
  return page.length >= max && Number.isFinite(oldest)
    ? { games: page, next: String(oldest - 1) }
    : { games: page };
}

/** Recent games of a lichess user, newest first. */
export async function fetchLichessGames(
  username: string,
  opts: FetchOptions = {},
): Promise<OnlineGame[]> {
  return (await fetchLichessPage(username, opts)).games;
}

export async function fetchLichessPgn(game: OnlineGame, opts: FetchOptions = {}): Promise<string> {
  const url = game.pgnUrl ?? `${GAME_URL}${encodeURIComponent(game.id)}?clocks=true&evals=false`;
  const res = await request(
    'lichess',
    url,
    'application/x-chess-pgn',
    opts.fetch ?? defaultFetch,
    'Game',
  );
  const pgn = await res.text();
  if (!pgn.trim()) throw new OnlineImportError('bad-response', 'Unexpected response from lichess');
  return pgn;
}
