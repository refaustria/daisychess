import { fetchChessComGames } from './chesscom';
import { fetchLichessGames, fetchLichessPgn } from './lichess';
import { OnlineImportError, type FetchOptions, type OnlineGame, type OnlineSite } from './types';

export * from './types';
export { fetchLichessGames, fetchLichessPgn, fetchChessComGames };

const USERNAME = /^[A-Za-z0-9_-]{2,30}$/;

/** Trims and validates a username; returns null when invalid. */
export function normalizeUsername(raw: string): string | null {
  const name = raw.trim();
  return USERNAME.test(name) ? name : null;
}

export async function fetchOnlineGames(
  site: OnlineSite,
  username: string,
  opts: FetchOptions = {},
): Promise<OnlineGame[]> {
  const name = normalizeUsername(username);
  if (!name) {
    throw new OnlineImportError(
      'invalid-username',
      'Enter a valid username (2–30 letters, digits, "_" or "-")',
    );
  }
  return site === 'lichess' ? fetchLichessGames(name, opts) : fetchChessComGames(name, opts);
}

/** Returns the PGN of a listed game, fetching it when the listing did not include it. */
export async function fetchOnlineGamePgn(game: OnlineGame, opts: FetchOptions = {}): Promise<string> {
  if (game.pgn) return game.pgn;
  return fetchLichessPgn(game, opts);
}
