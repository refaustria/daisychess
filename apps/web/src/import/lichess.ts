import {
  OnlineImportError,
  defaultFetch,
  request,
  type FetchOptions,
  type OnlineGame,
  type OnlinePlayer,
} from './types';

interface LichessPlayer {
  user?: { name?: string; id?: string };
  aiLevel?: number;
  rating?: number;
}

interface LichessGame {
  id?: unknown;
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
  const name = p?.user?.name ?? (p?.aiLevel !== undefined ? `Stockfish level ${p.aiLevel}` : 'Anonymous');
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
    pgnUrl: `${GAME_URL}${g.id}?clocks=false&evals=false`,
  };
  if (typeof g.speed === 'string') game.speed = g.speed;
  if (g.clock && typeof g.clock.initial === 'number') {
    const min = g.clock.initial / 60;
    game.timeControl = `${Number.isInteger(min) ? min : min.toFixed(2).replace(/0+$/, '')}+${g.clock.increment ?? 0}`;
  }
  if (g.opening?.name) game.opening = g.opening.name;
  return game;
}

/** Recent games of a lichess user, newest first. PGN is loaded lazily via fetchLichessPgn. */
export async function fetchLichessGames(username: string, opts: FetchOptions = {}): Promise<OnlineGame[]> {
  const max = opts.max ?? 20;
  const doFetch = opts.fetch ?? defaultFetch;
  const url =
    `https://lichess.org/api/games/user/${encodeURIComponent(username)}` +
    `?max=${max}&pgnInJson=false&clocks=false&evals=false&opening=true`;
  const res = await request('lichess', url, 'application/x-ndjson', doFetch, `User "${username}"`);
  const text = await res.text();
  const games: OnlineGame[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new OnlineImportError('bad-response', 'Unexpected response from lichess');
    }
    const g = mapGame(parsed);
    if (g) games.push(g);
  }
  return games.slice(0, max);
}

export async function fetchLichessPgn(game: OnlineGame, opts: FetchOptions = {}): Promise<string> {
  const url = game.pgnUrl ?? `${GAME_URL}${encodeURIComponent(game.id)}?clocks=false&evals=false`;
  const res = await request('lichess', url, 'application/x-chess-pgn', opts.fetch ?? defaultFetch, 'Game');
  const pgn = await res.text();
  if (!pgn.trim()) throw new OnlineImportError('bad-response', 'Unexpected response from lichess');
  return pgn;
}
