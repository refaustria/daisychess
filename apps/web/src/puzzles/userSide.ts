/**
 * Which side the user played in a reviewed game (ADR-023 §9), for the puzzles from the user's own
 * mistakes. Resolution order: engine game → the play store's colour; friend game → the room's
 * `you`; live lichess game → the user's colour there; otherwise (PGN, online import) a
 * case-insensitive match of the `White`/`Black` headers against the known names; otherwise
 * undefined ("Your mistakes" then asks once per game).
 *
 * The known names are the lichess login, the import tab's saved usernames per site and the "My
 * names" list of Settings → Puzzles (localStorage {@link MY_NAMES_KEY}).
 */
import { useLichessAuth } from '../lichess/auth';

export type Side = 'white' | 'black';

/** Where a ledger game came from. */
export type GameSource = 'play' | 'room' | 'live' | 'pgn' | 'import';

/**
 * The user's colour as reported by the game source that owns the game on the board (at most one
 * is set: the source whose game it is).
 */
export interface GameSources {
  play?: Side;
  room?: Side;
  live?: Side;
}

export interface ResolvedSide {
  source: GameSource;
  userSide?: Side;
}

export const MY_NAMES_KEY = 'daisychess.puzzles.names';
/** The import tab's saved usernames per site (`ImportPanel`, read only here). */
export const IMPORT_ONLINE_KEY = 'daisychess.import.online';
export const MAX_MY_NAMES = 20;
export const MAX_NAME_LENGTH = 50;

const norm = (s: string): string => s.trim().toLowerCase();

/** Names that never identify a player (`?` is the PGN placeholder). */
const PLACEHOLDERS = new Set(['', '?', '-', 'anonymous', 'unknown', 'white', 'black']);

/** A known online game URL: the game came from the import tab (lichess / chess.com). */
const ONLINE_SITE = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:lichess\.org|chess\.com)\//i;

/**
 * The game's URL from its headers: `Link` (chess.com) or `Site` when it is an http(s) URL.
 */
export function gameUrl(headers: Readonly<Record<string, string>>): string | undefined {
  for (const k of ['Link', 'Site'] as const) {
    const v = headers[k]?.trim();
    if (v && /^https?:\/\//i.test(v)) return v;
  }
  return undefined;
}

/**
 * The side whose `White`/`Black` header matches one of `names` (case-insensitive, trimmed);
 * undefined when neither or both match (a game against oneself tells nothing).
 */
export function sideFromNames(
  headers: Readonly<{ White?: string; Black?: string }>,
  names: readonly string[],
): Side | undefined {
  const known = new Set(names.map(norm).filter((n) => !PLACEHOLDERS.has(n)));
  if (known.size === 0) return undefined;
  const white = norm(headers.White ?? '');
  const black = norm(headers.Black ?? '');
  const w = !PLACEHOLDERS.has(white) && known.has(white);
  const b = !PLACEHOLDERS.has(black) && known.has(black);
  if (w === b) return undefined;
  return w ? 'white' : 'black';
}

/** Resolves source and side in the ADR order (see the module comment). Pure. */
export function resolveUserSide(
  headers: Readonly<Record<string, string>>,
  sources: GameSources,
  knownNames: readonly string[],
): ResolvedSide {
  if (sources.play) return { source: 'play', userSide: sources.play };
  if (sources.room) return { source: 'room', userSide: sources.room };
  if (sources.live) return { source: 'live', userSide: sources.live };
  const url = gameUrl(headers);
  const source: GameSource = url && ONLINE_SITE.test(url) ? 'import' : 'pgn';
  const userSide = sideFromNames(headers, knownNames);
  return userSide ? { source, userSide } : { source };
}

// --- known names ---------------------------------------------------------------------------------

/**
 * Splits a "My names" input (commas, semicolons or line breaks) into clean names: trimmed, at
 * most {@link MAX_NAME_LENGTH} characters, duplicates (case-insensitive) and placeholders dropped,
 * at most {@link MAX_MY_NAMES}.
 */
export function parseNames(input: string): string[] {
  return dedupe(input.split(/[,;\n\r]+/));
}

function dedupe(list: readonly unknown[], max: number = MAX_MY_NAMES): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().slice(0, MAX_NAME_LENGTH).trim();
    const key = norm(name);
    if (PLACEHOLDERS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
  } catch {
    return null;
  }
}

/** The "My names" list (defensive: anything malformed reads as empty). */
export function readMyNames(): string[] {
  const raw = readJson(MY_NAMES_KEY);
  return Array.isArray(raw) ? dedupe(raw) : [];
}

/** Stores the "My names" list (cleaned like {@link parseNames}); returns what was stored. */
export function writeMyNames(names: readonly string[]): string[] {
  const clean = dedupe(names);
  try {
    if (clean.length === 0) localStorage.removeItem(MY_NAMES_KEY);
    else localStorage.setItem(MY_NAMES_KEY, JSON.stringify(clean));
  } catch {
    /* storage unavailable: the names only live for this call */
  }
  return clean;
}

/** The import tab's saved usernames (lichess, chess.com). */
export function importUsernames(): string[] {
  const raw = readJson(IMPORT_ONLINE_KEY);
  if (!raw || typeof raw !== 'object') return [];
  const users = (raw as { users?: unknown }).users;
  if (!users || typeof users !== 'object') return [];
  return Object.values(users as Record<string, unknown>).filter(
    (v): v is string => typeof v === 'string',
  );
}

/** Every name known to be the user's: lichess login, import usernames, "My names". */
export function knownNames(): string[] {
  const login = useLichessAuth.getState().username;
  return dedupe([...(login ? [login] : []), ...importUsernames(), ...readMyNames()], Infinity);
}
