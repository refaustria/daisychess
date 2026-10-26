# @daisychess/mobile — iOS and Android apps

Capacitor 8 shell around the DaisyChess web app (ADR-022 in `docs/DECISIONS.md`). The app bundles
the web app's **mobile build** (`apps/web/dist-mobile`); there is no remote-URL mode.

|                           |                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Bundle id / applicationId | `org.daisychess.app`                                                                                         |
| Display name              | DaisyChess                                                                                                   |
| WebView origin            | Android `https://app.daisychess.org`, iOS `capacitor://app.daisychess.org` (`server.hostname`; never served) |
| Engine                    | `wasm:lite-single` only (the WebView is not cross-origin isolated)                                           |
| Default hub               | `wss://play.daisychess.org/ws` (`VITE_DEFAULT_SERVER_URL`; Settings → server URL overrides it)               |
| Minimums                  | Android 7.0 (API 24), iOS 15.0; build: Node 22+, JDK 21, Android SDK 36, Xcode 26                            |

## Layout

- `capacitor.config.ts` — app id, name, `webDir: ../web/dist-mobile`, hostname/scheme.
- `android/` — committed Gradle project (Capacitor template). Generated, git-ignored: copied web
  assets (`app/src/main/assets/public`), `capacitor.config.json`, `capacitor-cordova-android-plugins/`.
- `ios/App/` — committed Xcode project using **Swift Package Manager** (`CapApp-SPM/Package.swift`,
  rewritten by `cap sync`); no CocoaPods/Ruby. Generated, git-ignored: `App/App/public`,
  `capacitor.config.json`, `config.xml`, `DerivedData`.
- `scripts/check-dist.mjs` — asserts the mobile web build (lite-single only, CSP meta, no absolute
  asset URLs, size budget); runs in `build`.
- `scripts/check-smoke-log.mjs`, `scripts/android-smoke.sh`, `scripts/ios-smoke.sh` — the CI smoke.

## Build

```sh
pnpm install
pnpm --filter @daisychess/mobile build   # vite build --mode mobile → check-dist → cap sync (android + ios)
```

`build` works on Linux for both platforms (`cap sync` only copies files and writes `Package.swift`).
`cap sync` must leave the committed native files unchanged; CI checks that with `git diff`.

### Android (Linux/macOS)

Needs JDK 21 and the Android SDK (`ANDROID_HOME`, platform 36, build-tools 36).

```sh
cd apps/mobile/android
./gradlew assembleDebug                      # → app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n org.daisychess.app/.MainActivity
```

The Gradle distribution is pinned by `distributionSha256Sum` in `gradle/wrapper/gradle-wrapper.properties`.
Debug builds allow `chrome://inspect` for the WebView.

### iOS (macOS with Xcode 26)

```sh
open apps/mobile/ios/App/App.xcodeproj       # or:
cd apps/mobile/ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath ../DerivedData CODE_SIGNING_ALLOWED=NO build
```

Safari → Develop → Simulator inspects the WebView. Signing and store uploads are not part of this
package's build: `.github/workflows/release-mobile.yml` on `mobile-v*` tags (M26-8; secrets, owner
steps and the local signed-AAB build in `deploy/README.md`, "Mobile release"). Its helpers are
`scripts/release-version.mjs`, `scripts/asc-profile.mjs`, `scripts/ios-signing.mjs` and
`scripts/play-publish.mjs`.

## Mobile build mode of `apps/web`

`pnpm --filter @daisychess/web build:mobile` (`vite build --mode mobile` → `dist-mobile`) differs from
the web build in three ways (`apps/web/vite.config.ts`):

1. only `stockfish-19-lite-single.{js,wasm}` is emitted (no multi-threaded builds, no memory shim);
2. `VITE_DEFAULT_SERVER_URL` is defined (`wss://play.daisychess.org/ws`, overridable from the
   environment); `defaultServerUrl()` uses it inside the app (non-http(s) origin or native shell);
3. the production CSP from `apps/web/csp.config.mjs` is injected as `<meta http-equiv>`
   (`metaCsp()`: the header policy without `frame-ancestors`/`report-uri`/`sandbox`).

App code asks `isNativeApp()` / `nativePlatform()` from `apps/web/src/platform/` — constant `false` /
`null` in the web build.

## CI smoke

The `mobile` job in `.github/workflows/ci.yml` runs when `apps/mobile/**`, `apps/web/**`, the shared
packages, the lockfile or the workflow change. It builds with `VITE_MOBILE_SMOKE=1`, which compiles
`apps/web/src/platform/smoke.ts` into the bundle: on start the app logs one line

```
DAISYCHESS_SMOKE {"platform":"android","origin":"https://app.daisychess.org","isSecureContext":true,"crossOriginIsolated":false,"engine":"wasm:lite-single","bestmove":"e2e4","ms":…}
```

Capacitor forwards it to logcat (`Capacitor/Console`) on Android and to the app's stdout on iOS
(read with `simctl launch --console-pty`). `check-smoke-log.mjs` asserts a secure context, no
cross-origin isolation and a UCI `bestmove`. Logs, screenshots and the iOS unified log are uploaded
as the `mobile-smoke-<platform>` artefact. Store builds are never built with `VITE_MOBILE_SMOKE`.

Run the smoke locally against a running emulator:

```sh
VITE_MOBILE_SMOKE=1 pnpm --filter @daisychess/mobile build
(cd apps/mobile/android && ./gradlew assembleDebug)
bash apps/mobile/scripts/android-smoke.sh apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk apps/mobile/smoke/android
```

## Deep links (M26-3)

- iOS: `ios/App/App/App.entitlements` (`applinks:play.daisychess.org`, referenced by both build
  configurations), `CFBundleURLTypes` scheme `daisychess` in `Info.plist`. The App ID needs the
  Associated Domains capability (owner step, M26-9). `apple-app-site-association` (Team
  `PM7LTV7M72`) is served from `apps/web/public/.well-known/`.
- Android: `MainActivity` intent filters in `AndroidManifest.xml`: App Links
  `https://play.daisychess.org/` with exact path `/` (`autoVerify`, needs `assetlinks.json`,
  see `deploy/README.md`) and `daisychess://setup` and `org.daisychess.app://lichess-callback` (lichess login redirect; iOS registers both schemes).
- Web side: `apps/web/src/platform/appUrl.ts` (`registerAppUrlHandler(prefixOrMatcher, fn)`,
  `@capacitor/app` `appUrlOpen` + launch URL). Test on a device/emulator:
  `adb shell am start -a android.intent.action.VIEW -d 'daisychess://setup?token=dc1_x&hub=wss%3A%2F%2Fhub.example%2Fws'`,
  `xcrun simctl openurl booted 'daisychess://setup?token=dc1_x'`.

## Native polish and lifecycle (M26-4)

All of it lives in `apps/web/src/platform/` and is a no-op on the web: each plugin is loaded by a
lazy `import()` behind the literal `import.meta.env.MODE === 'mobile'` check in `native.ts`, so the
web bundle contains no plugin code. Plugins (exact pins in `apps/web` and `apps/mobile`):
`@capacitor/haptics`, `@capacitor/status-bar`, `@capacitor/preferences`,
`@capacitor-community/keep-awake` (MIT, maintained; Capacitor has no official keep-awake plugin).

- **Safe area**: the mobile build sets `viewport-fit=cover`; `App.module.css` pads with
  `max(env(safe-area-inset-*), var(--safe-area-inset-*))` (the variables come from Capacitor 8
  SystemBars on Android WebView < 140). The header background extends under the status bar.
- **Status bar**: style follows the effective theme (`data-theme` or the system scheme).
- **Haptics** (setting "Haptic feedback", default on, shown in the app only): light for a move,
  medium for a capture, heavy for check/mate, a notification at the end of an engine, live or
  friend game.
- **Keep awake** while an engine game, a live game, a friend game or an openings drill runs.
- **Back button** (Android): closes the topmost dialog (promotion chooser, engine picker and its
  download question register through `useBackHandler`), else goes back through the visited tabs,
  else exits the app on the first tab.
- **Lifecycle**: 2.5 s after `appStateChange` → inactive the engines are released (synthetic
  `pagehide`: the live analysis and the engine game dispose their engine, the shared pool is
  trimmed); on resume a persisted `pageshow` recreates them (the ADR-015 / M19-1 path).
- **Storage**: settings (with the server token), the theme and the lichess login are mirrored to
  Preferences; localStorage remains the synchronous read-through cache. A key purged from
  localStorage is restored from Preferences before the first render.

## Files and sharing (M26-5)

- **Open with / import**: iOS declares the exported type `org.daisychess.pgn` and a document type
  (Info.plist; `LSSupportsOpeningDocumentsInPlace=false`, so iOS copies the file into the app's Inbox).
  Android `MainActivity` has VIEW filters for `application/x-chess-pgn`, `application/vnd.chess-pgn`
  and `content:`/`file:` URIs ending in `.pgn`, and a SEND filter for the two PGN MIME types only
  (deliberately not `text/plain`); `MainActivity.java` turns SEND+`EXTRA_STREAM` into a VIEW intent
  so the App plugin reports it. Web side: `apps/web/src/platform/openedPgn.ts` registers on the
  `appUrlOpen` dispatcher for `file://`/`content://`, reads bytes with `@capacitor/filesystem`
  (UTF-8, else Windows-1252; 10 MB limit) and hands the text to the Import panel (multi-game picker).
- **Share**: `apps/web/src/platform/share.ts` (`@capacitor/share`, else `navigator.share`); buttons
  on the review (annotated PGN), the friend link and the setup link. Plugins are lazy and mobile-only
  like M26-4 (`@capacitor/filesystem` 8.1.5, `@capacitor/share` 8.0.3).
- Test on a device: `adb shell am start -a android.intent.action.VIEW -t application/x-chess-pgn -d content://...`
  (or open a `.pgn` from Files/Drive, and Share a `.pgn` to DaisyChess); iOS: Files → a `.pgn` →
  Share → DaisyChess, or Mail attachment → Open in. Simulator: `xcrun simctl openurl booted file:///path/x.pgn`.
