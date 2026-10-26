/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Engine server of the app when the page origin is not the server's (mobile build, ADR-022):
   * `wss://play.daisychess.org/ws` by default; undefined in the web build.
   */
  readonly VITE_DEFAULT_SERVER_URL?: string;
  /** `1`: run the native smoke check on start (CI only, `src/platform/smoke.ts`). */
  readonly VITE_MOBILE_SMOKE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
