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

## Openings

`src/openings/data/openings.json` (`[eco, name, epd][]`, ~464 kB, 63 kB gzipped) is generated from the lichess `chess-openings` TSVs (CC0) by `scripts/build-openings.mjs`; source commit in `data/SOURCE.md`. It is a separate lazy chunk, loaded by `useOpening()` the first time `MoveList` renders. `openingForGame` returns the deepest named position up to the current ply (so transpositions are recognised) and `null` for custom start positions; `MoveList` shows it as an ECO badge plus name (`aria-live="polite"`, hidden when null).

## Position explorer

`src/explorer/` (client + Zustand store) and `src/components/Explorer/ExplorerPanel` show the lichess Opening Explorer for the viewed position: Masters or Lichess database (speed/rating filters, default all speeds and 1600+), total games, W/D/L bar, popular moves (click plays the move via `makeMove`, branching like a board move; disabled while playing vs the engine), top games (Masters) or top/recent games (Lichess) with a Load button (Masters PGN from `explorer.lichess.org/masters/pgn/{id}`, lichess games from `lichess.org/game/export/{id}`; after loading the board jumps to the explored position).

- **Token required:** since November 2025 lichess answers every anonymous explorer request with `401` (DDoS protection, [lichess blog](https://lichess.org/@/thibault/blog/the-opening-explorer-now-requires-authentication/FSWh9Zg3)); limit about 20 requests/min per lichess account. The user pastes a lichess personal API token (no scopes) under Advanced; it is stored in localStorage `chesslab.explorer` (with db and filters) and sent only as `Authorization: Bearer` to `explorer.lichess.org`, never in URLs or logs and never to `lichess.org`. Without a token one request is tried; after a `401` the panel shows the token help instead of retrying.
- **Requests:** from the browser (CORS allows `Authorization`); host `https://explorer.lichess.org` is in CSP `connect-src`. Position changes are debounced 300 ms, stale requests aborted, results cached per (db, filters, start FEN + moves) for the session (LRU 200). Positions beyond 50 plies are not requested. `429` blocks requests for `Retry-After` (default 60 s; the header is not CORS-exposed) and retries automatically.
- The panel calls `setActive(true/false)` on mount/unmount, so the store only follows the game while the tab is open.

## Game review

- **Auto review:** `src/review/autoReview.ts` (installed by `App`) watches the game store. A load is a change that replaces `headers` or `startFen` and leaves at least 2 moves (`loadPgn`: PGN paste/file, online import); moves, takebacks, navigation, New game and FEN loads never qualify. With `settings.autoReview` on (Settings → "Analyse games automatically after loading", default on) and no game against the engine running, it resets the review store, starts `REVIEW_PRESETS.fast` with `{ auto: true }` and opens the Review tab. The panel then shows a dismissible "Auto review (fast) — run Deep for more accuracy" line; Start (or Run Deep) always restarts with the chosen preset.
- **Data:** `BatchAnalyzer` caches `eval`, `bestMove` and `pv` (UCI, at most 8 plies) per FEN and exposes the analysed `results` of a run. The review store keeps the unchanged engine-core `ReviewSummary` plus `moveDetails[ply]` (`review/details.ts`: played/best SAN, best line in SAN via `convertPv`, White-POV evals before/after, `evalIfBest`, mover-POV swing text, class), built incrementally while the review runs.
- **UI:** the Review tab shows a "Current move" card (`aria-live="polite"`) following the viewed ply: class with win-chance loss, "Better: …" with the clickable best line (board preview), eval before → after and a template sentence (`explainMove`); buttons jump to the previous/next mistake or blunder. When done: accuracy, counts, eval graph and per side "Good moves" (best/excellent, top 5) and "Moves to improve" (inaccuracy/mistake/blunder by loss). While the Review tab is open and a review exists, the board arrows are the played move (red mistake/blunder, orange inaccuracy, green otherwise) and the engine's best move (green) instead of the live-analysis arrow (`reviewShapes` in `components/Analysis/shapes.ts`).

## Tests

- `pnpm --filter @chesslab/web test` - Vitest (jsdom), components, stores, engine clients with fakes.
- `pnpm --filter @chesslab/web e2e` - Playwright. The config builds the app and serves it with `vite preview` on port 4180 (reused if already running), with COOP/COEP so the multi-threaded engine works. Specs: play, engine (lite, single and full builds), analysis, compare, backend (real server; also the access-token flow with `ACCESS_TOKEN` on port 8584)/remote (a fake WebSocket server in the spec), review, settings, `a11y.spec.ts` (axe on the main states, fails on serious/critical violations), `perf.spec.ts` (long-task budget during rapid navigation). Screenshots go to `test-results/screenshots` (override with `E2E_SHOTS_DIR`).

## Dev hooks

`window.__chesslab` (`src/engine/devHook.ts`) exposes factories used by e2e and the console: `createWasmEngine(options)`, `createRemoteEngine(options)` and `runReview(options)`. They only lazily import the engine code, so they are harmless in production.

## Accessibility notes

Tabs follow the WAI-ARIA tabs pattern (roving tabindex, arrows/Home/End). Global arrow-key navigation of the game is skipped for inputs, selects, tabs and radios, and when a modifier is held. The board is pointer-only; the keyboard path is the move list, the FEN field and the Import tab. Colours are tokens in `packages/ui-theme/src/base.css`; `prefers-reduced-motion` disables all transitions and animations there.
