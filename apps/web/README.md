# @chesslab/web

Vite + React 18 + TypeScript frontend. Product overview: [`../../README.md`](../../README.md).

## Structure

```
src/
  App.tsx            layout, tabs (Moves / Play / Import / Review / Settings; Review and Settings are lazy)
  components/        Board (chessground), Controls (keys, FEN), MoveList, Import, Analysis
                     (engine panel, tabs, compare strip), EvalBar, EngineToggle, ThemeToggle,
                     Review, Settings; each with a CSS module and tests
  store/             Zustand stores: gameStore (chess.js, history, navigation), analysisStore
                     (engines, lines, default + per-engine settings, page `env`; localStorage key
                     `chesslab.analysis`), previewStore (line preview), uiStore (active tab), settingsStore (themes,
                     server access token; localStorage key `chesslab.settings`), pgn helpers
  engine/            EngineClient implementations and glue: WasmEngineClient (Web Worker),
                     RemoteEngineClient (WebSocket protocol), UciSession, AnalysisController
                     (drives the stores), registry (browser + server engines), devHook
  play/              Play vs Engine: playStore (game lifecycle, pauses live analysis, aborts on
                     position load), PlayController (engine side, own WASM engine), outcome, strength
                     (Elo presets)
  review/            BatchAnalyzer (both backends), reviewStore, annotatePgn, format
  sound/             move sounds
e2e/                 Playwright specs (see below)
vite-plugin-stockfish.ts   emits the Stockfish WASM builds verbatim to
                     assets/engine/stockfish-<version>/ (versioned, cacheable as immutable)
```

## Engines and settings

- Registry keys (`src/engine/registry.ts`): `wasm:lite` (multi-thread, small network), `wasm:lite-single` (single-thread, works without cross-origin isolation), `wasm:full` (multi-thread with the full-strength network, ~99 MB `.wasm`, opt-in with a one-time download confirmation) and `remote:<engineId>` (server engines from the probe). `wasm:lite` and `wasm:full` replace each other: only one multi-threaded browser engine runs at a time.
- Analysis settings (ADR-010): `settings` in the analysis store are the defaults; `engineSettings[key]` overrides depth/MultiPV/threads per engine. With several engines the panel's selects edit the selected tab's engine ("Settings for …", "Apply to all"); with one engine they edit the defaults.
- Page capabilities (`crossOriginIsolated`, `hardwareConcurrency`) are read once into the analysis store (`env`); components use that instead of `navigator`, so unit tests set them explicitly and do not depend on the machine's core count.
- Engine server access token: Settings tab → "Server access token" (password field, show/hide, Save). It is sent in `hello.token`; saving reconnects the server engines. A server started with `ACCESS_TOKEN` answers a missing/wrong token with `unauthorized`, shown as "Access token required or wrong".

Shared logic (protocol, UCI parser, win probability, move classification) lives in `packages/engine-core`; themes in `packages/ui-theme`. Engine clients are lazy chunks; the main bundle holds chess.js, chessground, zustand and the Zod protocol schemas once.

## Tests

- `pnpm --filter @chesslab/web test` - Vitest (jsdom), components, stores, engine clients with fakes.
- `pnpm --filter @chesslab/web e2e` - Playwright. The config builds the app and serves it with `vite preview` on port 4180 (reused if already running), with COOP/COEP so the multi-threaded engine works. Specs: play, engine (lite, single and full builds), analysis, compare, backend (real server; also the access-token flow with `ACCESS_TOKEN` on port 8584)/remote (a fake WebSocket server in the spec), review, settings, `a11y.spec.ts` (axe on the main states, fails on serious/critical violations), `perf.spec.ts` (long-task budget during rapid navigation). Screenshots go to `test-results/screenshots` (override with `E2E_SHOTS_DIR`).

## Dev hooks

`window.__chesslab` (`src/engine/devHook.ts`) exposes factories used by e2e and the console: `createWasmEngine(options)`, `createRemoteEngine(options)` and `runReview(options)`. They only lazily import the engine code, so they are harmless in production.

## Accessibility notes

Tabs follow the WAI-ARIA tabs pattern (roving tabindex, arrows/Home/End). Global arrow-key navigation of the game is skipped for inputs, selects, tabs and radios, and when a modifier is held. The board is pointer-only; the keyboard path is the move list, the FEN field and the Import tab. Colours are tokens in `packages/ui-theme/src/base.css`; `prefers-reduced-motion` disables all transitions and animations there.
