import {
  OnlineImportError,
  defaultFetch,
  request,
  type FetchLike,
  type FetchOptions,
  type OnlineGame,
  type OnlinePage,
  type OnlinePlayer,
} from './types';

interface CcPlayer {
  username?: string;
  rating?: number;
  result?: string;
}

interface CcGame {
  url?: string;
  pgn?: unknown;
  end_time?: unknown;
  time_class?: unknown;
  time_control?: unknown;
  eco?: unknown;
  white?: CcPlayer;
  black?: CcPlayer;
}

const BASE = 'https://api.chess.com/pub/player/';

function player(p: CcPlayer | undefined): OnlinePlayer {
  const name = p?.username ?? 'Anonymous';
  return typeof p?.rating === 'number' ? { name, rating: p.rating } : { name };
}

function resultOf(g: CcGame): OnlineGame['result'] {
  if (g.white?.result === 'win') return '1-0';
  if (g.black?.result === 'win') return '0-1';
  if (g.white?.result && g.black?.result) return '1/2-1/2';
  return '*';
}

function timeControl(tc: unknown): string | undefined {
  if (typeof tc !== 'string') return undefined;
  const daily = /^1\/(\d+)$/.exec(tc);
  if (daily) return `${Math.round(Number(daily[1]) / 86400)}d`;
  const m = /^(\d+)(?:\+(\d+))?$/.exec(tc);
  if (!m) return undefined;
  const min = Number(m[1]) / 60;
  return `${Number.isInteger(min) ? min : min.toFixed(2).replace(/0+$/, '')}+${m[2] ?? 0}`;
}

/** "https://www.chess.com/openings/Kings-Indian-Defense-8.d5-Nb8" → "Kings Indian Defense" */
function openingName(eco: unknown): string | undefined {
  if (typeof eco !== 'string') return undefined;
  const slug = eco.split('/').pop() ?? '';
  const words: string[] = [];
  for (const w of slug.split('-')) {
    if (/^\d/.test(w)) break;
    words.push(w);
  }
  return words.length ? words.join(' ') : undefined;
}

function mapGame(raw: unknown): OnlineGame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const g = raw as CcGame;
  if (typeof g.pgn !== 'string' || typeof g.end_time !== 'number') return null;
  const id = g.url?.split('/').pop() ?? String(g.end_time);
  const game: OnlineGame = {
    id,
    site: 'chesscom',
    white: player(g.white),
    black: player(g.black),
    result: resultOf(g),
    date: new Date(g.end_time * 1000).toISOString(),
    pgn: g.pgn,
  };
  if (typeof g.time_class === 'string') game.speed = g.time_class;
  const tc = timeControl(g.time_control);
  if (tc) game.timeControl = tc;
  const opening = openingName(g.eco);
  if (opening) game.opening = opening;
  return game;
}

async function json(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new OnlineImportError('bad-response', 'Unexpected response from chess.com');
  }
}

async function month(url: string, doFetch: FetchLike): Promise<OnlineGame[]> {
  const res = await request('chesscom', url, 'application/json', doFetch, 'Games');
  const body = (await json(res)) as { games?: unknown };
  if (!body || !Array.isArray(body.games))
    throw new OnlineImportError('bad-response', 'Unexpected response from chess.com');
  const games: OnlineGame[] = [];
  for (const raw of body.games) {
    const g = mapGame(raw);
    if (g) games.push(g);
  }
  return games.reverse(); // API lists oldest first
}

/** Archive requests per call; sequential, so a long gap in activity cannot turn into a request storm. */
const MAX_ARCHIVES_PER_CALL = 12;

/**
 * Cursor = "<archive url>#<games already listed from it>" (newest first); the position is the first
 * game NOT yet listed. Archive URLs sort chronologically (…/YYYY/MM), so older = smaller.
 */
function parseCursor(cursor: string | undefined): { url: string; skip: number } | null {
  if (!cursor) return null;
  const at = cursor.lastIndexOf('#');
  if (at < 0) return null;
  const skip = Number(cursor.slice(at + 1));
  return Number.isInteger(skip) && skip >= 0 ? { url: cursor.slice(0, at), skip } : null;
}

/** One page of a chess.com user's games, newest first, walking monthly archives backwards. */
export async function fetchChessComPage(
  username: string,
  opts: FetchOptions = {},
): Promise<OnlinePage> {
  const max = opts.max ?? 20;
  const doFetch = opts.fetch ?? defaultFetch;
  const name = encodeURIComponent(username.toLowerCase());
  const res = await request(
    'chesscom',
    `${BASE}${name}/games/archives`,
    'application/json',
    doFetch,
    `User "${username}"`,
  );
  const body = (await json(res)) as { archives?: unknown };
  if (!body || !Array.isArray(body.archives))
    throw new OnlineImportError('bad-response', 'Unexpected response from chess.com');
  const archives = body.archives
    .filter((a): a is string => typeof a === 'string' && a.startsWith(`${BASE}${name}/games/`))
    .sort()
    .reverse(); // newest first
  const from = parseCursor(opts.cursor);
  const todo = from ? archives.filter((a) => a <= from.url) : archives;
  const games: OnlineGame[] = [];
  let next: string | undefined;
  for (let i = 0; i < todo.length; i++) {
    const url = todo[i] as string;
    if (i >= MAX_ARCHIVES_PER_CALL) {
      next = `${url}#0`;
      break;
    }
    const skip = from && url === from.url ? from.skip : 0;
    const list = (await month(url, doFetch)).slice(skip);
    const room = max - games.length;
    games.push(...list.slice(0, room));
    if (list.length > room) {
      next = `${url}#${skip + room}`;
      break;
    }
    if (games.length >= max) {
      const older = todo[i + 1];
      if (older) next = `${older}#0`;
      break;
    }
  }
  return next ? { games, next } : { games };
}

/** Recent games of a chess.com user, newest first. */
export async function fetchChessComGames(
  username: string,
  opts: FetchOptions = {},
): Promise<OnlineGame[]> {
  return (await fetchChessComPage(username, opts)).games;
}
