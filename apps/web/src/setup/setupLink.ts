import { parseRemoteUrl } from '../engine/serverUrl';
import { MAX_SERVER_TOKEN_LENGTH, normalizeToken } from '../store/settingsStore';

/**
 * Setup link for another device: `https://<origin>/#setup-token=<urlencoded token>`.
 * The token sits in the URL fragment, which browsers never send to the server (it can still end
 * up in the sender's/recipient's message history and browser history; see docs/SECURITY.md).
 */
export const SETUP_HASH_PREFIX = '#setup-token=';
export const HUB_FRAGMENT_KEY = '&hub=';
export const SETUP_SAVED_NOTICE = 'Server access token saved on this device';
export const SETUP_HUB_SAVED_NOTICE = 'Server address and access token saved on this device';
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

/** A parsed setup link: the token and, for self-hosted hubs, the hub's `ws(s)://` URL. */
export interface SetupPayload {
  token: string;
  hub?: string;
}

/**
 * Parses `#setup-token=<token>[&hub=<wss url>]`. The token is validated like the Settings field
 * (trimmed, at most {@link MAX_SERVER_TOKEN_LENGTH} characters, not empty), the hub like
 * `settings.remoteUrl` ({@link parseRemoteUrl}). A link whose token or hub is malformed is
 * rejected as a whole (null): a token must never be stored for a hub it was not meant for.
 */
export function parseSetupPayload(hash: string): SetupPayload | null {
  if (!isSetupHash(hash)) return null;
  const rest = hash.slice(SETUP_HASH_PREFIX.length);
  const cut = rest.indexOf(HUB_FRAGMENT_KEY);
  const rawToken = cut < 0 ? rest : rest.slice(0, cut);
  let token: string;
  let hub: string | undefined;
  try {
    token = decodeURIComponent(rawToken).trim();
    if (cut >= 0) {
      hub = parseRemoteUrl(decodeURIComponent(rest.slice(cut + HUB_FRAGMENT_KEY.length)));
      if (hub === undefined) return null;
    }
  } catch {
    return null;
  }
  if (token.length === 0 || token.length > MAX_SERVER_TOKEN_LENGTH) return null;
  return { token: normalizeToken(token), ...(hub !== undefined ? { hub } : {}) };
}

/** The token of a `#setup-token=…` hash (see {@link parseSetupPayload}), or null. */
export function parseSetupHash(hash: string): string | null {
  return parseSetupPayload(hash)?.token ?? null;
}

/**
 * `daisychess://setup?token=<t>&hub=<wss url>` (custom scheme for self-hosted hubs, ADR-022 §4)
 * as the equivalent `#setup-token=…&hub=…` fragment, or null when it is not a setup URL.
 */
export function schemeSetupToHash(url: string): string | null {
  const m = /^daisychess:\/\/setup\/?\?([^#]*)/i.exec(url);
  if (!m) return null;
  const params = new URLSearchParams(m[1]);
  const token = params.get('token');
  if (token === null) return null;
  const hub = params.get('hub');
  return `${SETUP_HASH_PREFIX}${encodeURIComponent(token)}${
    hub === null ? '' : `${HUB_FRAGMENT_KEY}${encodeURIComponent(hub)}`
  }`;
}

export interface SetupDeps {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'replaceState' | 'state'>;
  setToken(token: string): void;
  /** Stores the hub URL of a `&hub=` link as the engine server (settings.remoteUrl). */
  setHub?(url: string): void;
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
  const payload = parseSetupPayload(loc.hash);
  try {
    history.replaceState(history.state, '', `${loc.pathname}${loc.search}`);
  } catch {
    /* history unavailable */
  }
  if (payload === null) return false;
  deps.setToken(payload.token);
  if (payload.hub !== undefined && deps.setHub) {
    deps.setHub(payload.hub);
    deps.notify(SETUP_HUB_SAVED_NOTICE);
  } else deps.notify(SETUP_SAVED_NOTICE);
  return true;
}
