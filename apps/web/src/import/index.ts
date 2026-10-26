import { fetchChessComGames, fetchChessComPage } from './chesscom';
import { fetchLichessGames, fetchLichessPage, fetchLichessPgn } from './lichess';
import {
  OnlineImportError,
  type FetchOptions,
  type OnlineGame,
  type OnlinePage,
  type OnlineSite,
} from './types';

export * from './types';
export {
  fetchLichessGames,
  fetchLichessPage,
  fetchLichessPgn,
  fetchChessComGames,
  fetchChessComPage,
};

const USERNAME = /^[A-Za-z0-9_-]{2,30}$/;

/** Trims and validates a username; returns null when invalid. */
export function normalizeUsername(raw: string): string | null {
  const name = raw.trim();
  return USERNAME.test(name) ? name : null;
}

/** One page of a user's games (newest first) plus the cursor for the next older page. */
export async function fetchOnlinePage(
  site: OnlineSite,
  username: string,
  opts: FetchOptions = {},
): Promise<OnlinePage> {
  const name = normalizeUsername(username);
  if (!name) {
    throw new OnlineImportError(
      'invalid-username',
      'Enter a valid username (2–30 letters, digits, "_" or "-")',
    );
  }
  return site === 'lichess' ? fetchLichessPage(name, opts) : fetchChessComPage(name, opts);
}

export async function fetchOnlineGames(
  site: OnlineSite,
  username: string,
  opts: FetchOptions = {},
): Promise<OnlineGame[]> {
  return (await fetchOnlinePage(site, username, opts)).games;
}

/** Returns the PGN of a listed game, fetching it when the listing did not include it. */
export async function fetchOnlineGamePgn(
  game: OnlineGame,
  opts: FetchOptions = {},
): Promise<string> {
  if (game.pgn) return game.pgn;
  return fetchLichessPgn(game, opts);
}
