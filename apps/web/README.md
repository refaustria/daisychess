# @chesslab/web

Vite + React 18 + TypeScript frontend. Product overview: [`../../README.md`](../../README.md).

## Structure

```
src/
  App.tsx            layout, tabs (Moves / Import / Review / Settings; the last two are lazy)
  components/        Board (chessground), Controls (keys, FEN), MoveList, Import, Analysis
                     (engine panel, tabs, compare strip), EvalBar, EngineToggle, ThemeToggle,
                     Review, Settings; each with a CSS module and tests
  store/             Zustand stores: gameStore (chess.js, history, navigation), analysisStore
                     (engines, lines, backend), previewStore (line preview), settingsStore (themes;
                     localStorage key `chesslab.settings`), pgn helpers
  engine/            EngineClient implementations and glue: WasmEngineClient (Web Worker),
                     RemoteEngineClient (WebSocket protocol), UciSession, AnalysisController
                     (drives the stores), registry (browser + server engines), devHook
  review/            BatchAnalyzer (both backends), reviewStore, annotatePgn, format
  sound/             move sounds
e2e/                 Playwright specs (see below)
vite-plugin-stockfish.ts   emits the Stockfish WASM builds verbatim to
                     assets/engine/stockfish-<version>/ (versioned, cacheable as immutable)
```

Shared logic (protocol, UCI parser, win probability, move classification) lives in `packages/engine-core`; themes in `packages/ui-theme`. Engine clients are lazy chunks; the main bundle holds chess.js, chessground, zustand and the Zod protocol schemas once.

## Tests

- `pnpm --filter @chesslab/web test` - Vitest (jsdom), components, stores, engine clients with fakes.
- `pnpm --filter @chesslab/web e2e` - Playwright. The config builds the app and serves it with `vite preview` on port 4180 (reused if already running), with COOP/COEP so the multi-threaded engine works. Specs: play, engine, analysis, compare, backend/remote (a fake WebSocket server in the spec), review, settings, `a11y.spec.ts` (axe on the main states, fails on serious/critical violations), `perf.spec.ts` (long-task budget during rapid navigation). Screenshots go to `test-results/screenshots` (override with `E2E_SHOTS_DIR`).

## Dev hooks

`window.__chesslab` (`src/engine/devHook.ts`) exposes factories used by e2e and the console: `createWasmEngine(options)`, `createRemoteEngine(options)` and `runReview(options)`. They only lazily import the engine code, so they are harmless in production.

## Accessibility notes

Tabs follow the WAI-ARIA tabs pattern (roving tabindex, arrows/Home/End). Global arrow-key navigation of the game is skipped for inputs, selects, tabs and radios, and when a modifier is held. The board is pointer-only; the keyboard path is the move list, the FEN field and the Import tab. Colours are tokens in `packages/ui-theme/src/base.css`; `prefers-reduced-motion` disables all transitions and animations there.
