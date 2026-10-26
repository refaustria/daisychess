import { isNativeApp } from '../platform';

/**
 * Default engine server: `ws(s)://<current host>/ws`, the server behind the same origin (nginx in
 * production, the Vite proxy in development). Kept apart from `RemoteEngineClient` so that
 * importing it does not pull the client into the main chunk.
 *
 * The mobile build (ADR-022) defines `VITE_DEFAULT_SERVER_URL`; it is used when the page origin
 * cannot be the server: a non-http(s) origin (iOS `capacitor://app.daisychess.org`) or the native
 * app at all (Android serves the bundle from `https://app.daisychess.org`, a name nobody serves).
 * The web build does not define it, so the web behaviour is unchanged.
 */
export function defaultServerUrl(): string {
  const loc = globalThis.location;
  const fixed = import.meta.env.VITE_DEFAULT_SERVER_URL;
  const httpOrigin = loc.protocol === 'https:' || loc.protocol === 'http:';
  if (fixed && (!httpOrigin || isNativeApp())) return fixed;
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}
