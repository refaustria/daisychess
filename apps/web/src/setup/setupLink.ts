import { MAX_SERVER_TOKEN_LENGTH, normalizeToken } from '../store/settingsStore';

/**
 * Setup link for another device: `https://<origin>/#setup-token=<urlencoded token>`.
 * The token sits in the URL fragment, which browsers never send to the server (it can still end
 * up in the sender's/recipient's message history and browser history; see docs/SECURITY.md).
 */
export const SETUP_HASH_PREFIX = '#setup-token=';
export const SETUP_SAVED_NOTICE = 'Server access token saved on this device';
export const SETUP_LINK_WARNING =
  'Anyone with this link can use your engine server. Open it once on the other device, then delete it from your messages.';

/** The setup link for `token` (`<origin><path>#setup-token=…`; the path keeps sub-path deploys working). */
export function setupLink(
  token: string,
  loc: Pick<Location, 'origin' | 'pathname'> = location,
): string {
  return `${loc.origin}${loc.pathname}${SETUP_HASH_PREFIX}${encodeURIComponent(token)}`;
}

/** True when `hash` is a setup-token fragment (never a `#/room/…` route or an OAuth callback). */
export const isSetupHash = (hash: string): boolean => hash.startsWith(SETUP_HASH_PREFIX);

/**
 * The token of a `#setup-token=<token>` hash, validated like the Settings field (trimmed, at most
 * {@link MAX_SERVER_TOKEN_LENGTH} characters, not empty), or null.
 */
export function parseSetupHash(hash: string): string | null {
  if (!isSetupHash(hash)) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(hash.slice(SETUP_HASH_PREFIX.length));
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SERVER_TOKEN_LENGTH) return null;
  return normalizeToken(trimmed);
}

export interface SetupDeps {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'replaceState' | 'state'>;
  setToken(token: string): void;
  notify(text: string): void;
}

/**
 * Handles a setup link on app start: stores the token, removes the fragment from the address bar
 * (path and query stay) and shows the one-time notice. A malformed/empty/too long token is
 * dropped silently, the fragment is removed anyway. Returns whether a token was saved. Never
 * logs the token.
 */
export function consumeSetupLink(deps: SetupDeps): boolean {
  const { location: loc, history } = deps;
  if (!isSetupHash(loc.hash)) return false;
  const token = parseSetupHash(loc.hash);
  try {
    history.replaceState(history.state, '', `${loc.pathname}${loc.search}`);
  } catch {
    /* history unavailable */
  }
  if (token === null) return false;
  deps.setToken(token);
  deps.notify(SETUP_SAVED_NOTICE);
  return true;
}
