/**
 * App URL dispatcher (ADR-022 §4): the one place that receives URLs the OS hands to the native
 * app (universal links, Android App Links, the `daisychess://` scheme) and routes them. Features
 * register their handler with {@link registerAppUrlHandler}; {@link installAppUrlRouting} wires
 * the `@capacitor/app` events in the native shell (a no-op on the web, where the page URL is the
 * link and the existing hash routes handle it).
 */
import { isSetupHash, schemeSetupToHash } from '../setup/setupLink';
import { parseRoomHash } from '../room/route';
import { isNativeApp } from './index';

/** The origin whose links the apps claim (`apple-app-site-association`, `assetlinks.json`). */
export const APP_LINK_ORIGIN = 'https://play.daisychess.org';
export const APP_SCHEME = 'daisychess://';

export type AppUrlMatcher = string | ((url: string) => boolean);
export type AppUrlHandler = (url: string) => void;

interface Entry {
  match: (url: string) => boolean;
  fn: AppUrlHandler;
}

const entries: Entry[] = [];

const toMatch = (m: AppUrlMatcher): ((url: string) => boolean) =>
  typeof m === 'string' ? (url) => url.toLowerCase().startsWith(m.toLowerCase()) : m;

/**
 * Registers `fn` for URLs that start with `prefixOrMatcher` (case-insensitive) or for which the
 * matcher function returns true. Every matching handler runs, in registration order; a handler
 * that throws does not stop the others. Returns the unregister function.
 */
export function registerAppUrlHandler(
  prefixOrMatcher: AppUrlMatcher,
  fn: AppUrlHandler,
): () => void {
  const entry: Entry = { match: toMatch(prefixOrMatcher), fn };
  entries.push(entry);
  return () => {
    const i = entries.indexOf(entry);
    if (i >= 0) entries.splice(i, 1);
  };
}

/** Runs the handlers matching `url`; returns how many ran. */
export function dispatchAppUrl(url: string): number {
  let ran = 0;
  for (const e of [...entries]) {
    let hit = false;
    try {
      hit = e.match(url);
    } catch {
      /* a broken matcher never matches */
    }
    if (!hit) continue;
    ran++;
    try {
      e.fn(url);
    } catch {
      /* one failing handler must not stop the others (and never logs the URL: it can hold a token) */
    }
  }
  return ran;
}

/** The fragment of a URL under {@link APP_LINK_ORIGIN} (`#…`, `''` without one), or null for any other URL. */
export function appLinkHash(url: string): string | null {
  const lower = url.toLowerCase();
  if (
    lower !== APP_LINK_ORIGIN &&
    !lower.startsWith(`${APP_LINK_ORIGIN}/`) &&
    !lower.startsWith(`${APP_LINK_ORIGIN}#`)
  )
    return null;
  const i = url.indexOf('#');
  return i < 0 ? '' : url.slice(i);
}

/** The `#setup-token=…[&hub=…]` fragment carried by a setup URL (https link or scheme), or null. */
export function setupHashOfUrl(url: string): string | null {
  const viaScheme = schemeSetupToHash(url);
  if (viaScheme !== null) return viaScheme;
  const h = appLinkHash(url);
  return h !== null && isSetupHash(h) ? h : null;
}

/** The room hash (`#/room/<id>`) carried by a universal link, or null. */
export function roomHashOfUrl(url: string): string | null {
  const h = appLinkHash(url);
  return h !== null && parseRoomHash(h) !== null ? h : null;
}

export interface AppUrlRoutes {
  /** Consumes a `#setup-token=…` fragment (token, optional hub). */
  setup(hash: string): void;
  /** Opens the room route (`#/room/<id>`). */
  room(hash: string): void;
}

/** Registers the built-in routes: setup links and room links. Returns the unregister function. */
export function registerBuiltinAppUrlHandlers(routes: AppUrlRoutes): () => void {
  const offs = [
    registerAppUrlHandler(
      (u) => setupHashOfUrl(u) !== null,
      (u) => {
        const h = setupHashOfUrl(u);
        if (h !== null) routes.setup(h);
      },
    ),
    registerAppUrlHandler(
      (u) => roomHashOfUrl(u) !== null,
      (u) => {
        const h = roomHashOfUrl(u);
        if (h !== null) routes.room(h);
      },
    ),
  ];
  return () => offs.forEach((off) => off());
}

let lastUrl = '';
let lastAt = 0;
/** The OS can report the launch URL twice (launch URL and `appUrlOpen`): drop an immediate repeat. */
const REPEAT_WINDOW_MS = 1500;

/** Entry point for URLs from the OS: dedupes immediate repeats, then dispatches. */
export function handleOpenedUrl(url: string, now: number = Date.now()): number {
  if (url === lastUrl && now - lastAt < REPEAT_WINDOW_MS) return 0;
  lastUrl = url;
  lastAt = now;
  return dispatchAppUrl(url);
}

/** Test seam: forgets the repeat guard and all handlers. */
export function resetAppUrl(): void {
  entries.length = 0;
  lastUrl = '';
  lastAt = 0;
}

/**
 * Native shell only: listens to `appUrlOpen` and handles the URL the app was launched with.
 * `@capacitor/app` is imported lazily behind the build-mode check, so the web bundle has no trace
 * of it.
 */
export async function installAppUrlRouting(): Promise<void> {
  if (import.meta.env.MODE !== 'mobile' || !isNativeApp()) return;
  const { App } = await import('@capacitor/app');
  await App.addListener('appUrlOpen', (e) => void handleOpenedUrl(e.url));
  const launch = await App.getLaunchUrl();
  if (launch?.url) handleOpenedUrl(launch.url);
}
