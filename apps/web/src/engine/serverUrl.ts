/**
 * `ws(s)://<current host>/ws` — the engine server behind the same origin (nginx in production,
 * the Vite proxy in development). Kept apart from `RemoteEngineClient` so that importing it does
 * not pull the client into the main chunk.
 */
export function defaultServerUrl(): string {
  const loc = globalThis.location;
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}
