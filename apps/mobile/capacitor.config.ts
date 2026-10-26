import type { CapacitorConfig } from '@capacitor/cli';

/**
 * DaisyChess iOS/Android shell (ADR-022): the web app built with `vite build --mode mobile`
 * (`apps/web/dist-mobile`) bundled into the native projects.
 *
 * `server.hostname` fixes the WebView origin: Android `https://app.daisychess.org`, iOS
 * `capacitor://app.daisychess.org`. The name is never served by us, so no web page can carry that
 * origin; the hub allow-lists both (M26-2).
 */
const config: CapacitorConfig = {
  appId: 'org.daisychess.app',
  appName: 'DaisyChess',
  webDir: '../web/dist-mobile',
  server: {
    hostname: 'app.daisychess.org',
    androidScheme: 'https',
  },
};

export default config;
