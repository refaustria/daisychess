/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Engine server of the app when the page origin is not the server's (mobile build, ADR-022):
   * `wss://play.daisychess.org/ws` by default; undefined in the web build.
   */
  readonly VITE_DEFAULT_SERVER_URL?: string;
  /**
   * Puzzle files of the apps (ADR-023 §5): `https://play.daisychess.org/puzzles/v1/` when unset;
   * the web build always uses its own origin's `/puzzles/v1/`.
   */
  readonly VITE_PUZZLES_URL?: string;
  /** `1`: run the native smoke check on start (CI only, `src/platform/smoke.ts`). */
  readonly VITE_MOBILE_SMOKE?: string;
  /**
   * Smoke builds only: a loopback engine server (`ws://127.0.0.1:<port>/ws`) the smoke check
   * connects to and expects `welcome` from (M26-2: the app's origin passes the hub's allowlist).
   */
  readonly VITE_MOBILE_SMOKE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Build identity injected by Vite `define` (vite.config.ts, buildInfoDefines). */
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILD__: string;
declare const __APP_MOBILE__: boolean;
