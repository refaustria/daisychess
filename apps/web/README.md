# @daisychess/web

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
                     `daisychess.analysis`), previewStore (line preview), uiStore (active tab), settingsStore (themes,
                     server access token; localStorage key `daisychess.settings`), pgn helpers
  engine/            EngineClient implementations and glue: WasmEngineClient (Web Worker),
                     RemoteEngineClient (WebSocket protocol), UciSession, AnalysisController
                     (drives the stores), registry (browser + server engines), devHook
  play/              Play vs Engine: playStore (game lifecycle, clock, pauses live analysis, aborts on
                     position load; last setup in localStorage `daisychess.play`), PlayController (engine
                     side, own WASM engine), outcome, strength (Elo presets)
  clock/             shared chess clock: Clock component (also used by live games), formatClock,
                     gameClock (pure two-sided Fischer clock + engine time budget), timeControls
                     (lichess categories, presets, custom; `live/timeControls.ts` re-exports it)
  live/              Live lichess games (Board API): boardApi (typed client, NDJSON streams), liveStore,
                     LiveGameController (mirrors the game into gameStore), premoves (queue), lock
                     (the human-game engine lock), useHumanBoard (board movability/premoves)
  review/            BatchAnalyzer (both backends), reviewStore, annotatePgn, format
  sound/             move sounds
  lichess/           lichess login (OAuth PKCE): pkce helpers, auth store useLichessAuth, getLichessToken,
                     lichessFetch, hasScope (localStorage `daisychess.lichess`); UI in components/LichessAccount
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

## Clocks and time controls (Play vs Engine)

- **Setup:** Play tab → "Time control": presets grouped by lichess category (estimated duration = initial + 40 × increment: < 30 s UltraBullet, < 3 min Bullet, < 8 min Blitz, < 25 min Rapid, else Classical) — Bullet 1+0, 2+1; Blitz 3+0, 3+2, 5+0, 5+3; Rapid 10+0, 10+5, 15+10; Classical 30+0, 30+20 — plus "Custom…" (0.25–180 min, 0–60 s increment, clamped) and "No clock" (the previous behaviour). Labels read `3+2 · Blitz`. The whole setup (colour, strength, thinking time, time control) is remembered in localStorage `daisychess.play`.
- **Clock model** (`clock/gameClock.ts`, state `clock: { w, b, runningSide, lastTickAt, flagged }` in the play store): only the side to move runs; a completed move charges the elapsed time, adds the increment (Fischer) and starts the other side. Time is measured with `performance.now()` deltas, and every transition charges the exact elapsed time, so the 100 ms ticker (display and flag detection) may be throttled in a background tab without losing time. A takeback runs the user's clock again without increment. The user's clock starts at once when they have White; the engine's clock runs only while it searches (loading the WASM engine for its first move is not charged) and stops when its move is ready. Reaching 0 ends the game with reason `timeout` ("You lost on time" / "Engine lost on time"); a finished game freezes both clocks.
- **Engine time:** with a clock the thinking time per move is `min(configured, max(50 ms, min(remaining/30 + 0.8 × increment, remaining/2)))`, so even at full strength the engine keeps a geometric reserve and does not flag itself in normal-length games; the random reply delay is skipped.
- **UI:** engine clock above the status, the user's below (`Clock`: m:ss, tenths under 10 s, h:mm:ss from an hour; the running clock pulses (not with reduced motion), low time (< 20 s, for short games < 10 % of the initial time) in the danger colour, flagged bold; `role="timer"`, `aria-live="off"`, `aria-label="White clock 9:58"`). The live games use the same component.
- Start is disabled while a live lichess game runs ("A live game is running"); premoves (Settings → Premoves) work the same against the engine.

## lichess login

"Log in with lichess" (Settings → lichess account, or the account chip in the header, which opens Settings) uses the OAuth 2.0 authorization code flow with PKCE (`src/lichess/`; no client secret, `client_id` `daisychess.c.referee.at`, redirect URI = `location.origin + location.pathname`, so it works on `https://c.referee.at/` and `http://localhost:4180/`).

- `login()` stores a random verifier + `state` in sessionStorage `daisychess.lichess.pkce` and navigates to `https://lichess.org/oauth` with the S256 challenge and the scopes `board:play challenge:read challenge:write` (for live games; shown in the button's tooltip).
- `main.tsx` calls `handleCallback()` once at startup: with `?code&state` and a matching state it exchanges the code (`POST /api/token`), reads the username (`GET /api/account`), stores `{token, username, scopes, expiresAt}` in localStorage `daisychess.lichess` and removes the parameters with `history.replaceState`. `?error=` and a state mismatch end in status `error` with a message.
- `logout()` forgets the token and revokes it (`DELETE /api/token`, failures ignored). A `401` through `lichessFetch` logs out with "please log in again". Other tabs follow via the `storage` event.
- Non-React code uses `getLichessToken()`, `hasScope()` and `lichessFetch(urlOrPath, init)` (adds `Authorization: Bearer` while logged in; only `https://lichess.org` / `https://explorer.lichess.org`, paths are resolved against lichess.org).
- Consumers: the explorer prefers the login token over a pasted one; Import → "My games" (visible when logged in) fetches the user's own games with the token. Token handling: `docs/SECURITY.md` §2.8a.


**Personal access token (alternative).** Settings → lichess account → "Use a personal access token instead": create a token on lichess (the link prefills `board:play`, `challenge:read`, `challenge:write`), paste it (hidden by default) and "Save lichess token". `loginWithToken()` checks it with `POST /api/token/test` (token in the request body only), reads scopes and expiry, fetches the username from `/api/account` and stores the same `daisychess.lichess` entry with `source: 'token'` (older entries without `source` count as OAuth). Missing permissions are listed with a hint to create a new token. Logging out of a pasted token only forgets it here; it stays valid on lichess (an OAuth login is revoked).

## Live games on lichess

The Live tab (`components/Live/LivePanel`, state in `src/live/`) plays real lichess games through the [Board API](https://lichess.org/api#tag/Board) with the login token (`board:play`, `challenge:read`, `challenge:write`; see "lichess login"). Without a login (or without `board:play`) the panel offers "Log in with lichess" / "Log in again".

- **Setup:** Quick pairing (lobby seek; the Board API only allows Rapid and Classical there: 10+0, 10+5, 15+10, 30+0, 30+20), "Play the lichess computer" (level 1–8, blitz clocks allowed), "Challenge a friend" (username, clock, rated). Incoming challenges (Accept/Decline) and ongoing games (Resume) are listed. A seek or pending challenge shows a spinner and Cancel (the seek is a kept-open `POST /api/board/seek`, aborting it cancels).
- **Streams** (`boardApi.ts`): `fetch` + `ReadableStream` + `TextDecoder` NDJSON reader (keep-alive blank lines skipped, lines and UTF-8 characters split across chunks joined). The event stream (`/api/stream/event`) runs while the panel is open or a game/seek is on and reconnects with exponential backoff (0.5 s → 30 s; `429` waits `Retry-After`; `401` stops). A `gameStart` is joined only when the user is waiting for it (a seek: a game id not ongoing before; a challenge/AI/accept: its id); other games appear under "ongoing". The game stream reconnects the same way; lichess resends `gameFull`.
- **Mirror** (`LiveGameController`): lichess is the source of truth. The game store holds the lichess moves (replayed with chess.js), new moves are appended without moving a user who browses earlier moves, a store changed locally (New game, a move on an earlier ply) is rebuilt. The user's board move is sent (optimistic) and rolled back when lichess rejects it (`400`). The board only accepts the user's colour, at the tip, on their turn.
- **Clocks:** from the last `gameState` (`wtime/btime` at receive time); only the side to move ticks, and only after both sides have moved (lichess rule); the Live panel re-renders every 100 ms only while a clock runs. Rendered with the shared `clock/Clock` (see "Clocks and time controls"); the status line (`Your move`, `Waiting for opponent`, `Opponent left`) is `aria-live="polite"`.
- **Game actions:** Offer draw / Accept / Decline (banner), Abort (fewer than 2 moves), Resign (with confirmation), Claim victory (after `opponentGone.claimWinInSeconds`). The finish (status other than created/started) shows result and reason, "New game", "Review this game" and a link to the game on lichess. The Board API has no rematch.
- **Premoves** (Settings → Premoves, `settings.premoves`): `none`, `single` (chessground's premove, a new one replaces it; default) or `queue` (several, drawn as numbered grey arrows and listed in the Live panel as "Premoves: e4, Nf3 (Esc to clear)"). `live/premoves.ts` plays the first one when it is the user's turn at the tip, if chess.js says it is legal; an illegal one (also one made illegal by the opponent's move) clears the whole queue; Escape or a right-click on the board clears it too. In queue mode each premove is entered from the current position (the board does not show earlier premoves as played). The same setting applies to the game against the local engine (Play tab).
- **Fair play:** while a live game runs or a seek/challenge is pending, all engine help is hard-locked (`live/lock.ts`, the single rule used by the engine switch, the review and the explorer): the live analysis is forced off and any attempt to switch it on is reverted at once by the live store (the switch is disabled with "Disabled during a live game (lichess fair play)"), review Start/Run Deep are disabled, a running review is cancelled and the auto review is skipped. A game against the local engine cannot start during a live game and vice versa (a `gameStart` while an engine game runs ends the engine game). When the live game ends the analysis comes back (if it was on) and a fast review starts in the background (setting `autoReview`).
- **Tests:** Vitest for the client (NDJSON, requests, errors), controller (mirror, send/rollback, premoves, clocks, finish, opponent gone, reconnect), store, lock, premove queue and panel; `e2e/live.spec.ts` mocks lichess with `page.route()` (stored login in `localStorage['daisychess.lichess']`).

## Position explorer

`src/explorer/` (client + Zustand store) and `src/components/Explorer/ExplorerPanel` show the lichess Opening Explorer for the viewed position: Masters or Lichess database (speed/rating filters, default all speeds and 1600+), total games, W/D/L bar, popular moves (click plays the move via `makeMove`, branching like a board move; disabled while playing vs the engine), top games (Masters) or top/recent games (Lichess) with a Load button (Masters PGN from `explorer.lichess.org/masters/pgn/{id}`, lichess games from `lichess.org/game/export/{id}`; after loading the board jumps to the explored position).

- **Token required:** since November 2025 lichess answers every anonymous explorer request with `401` (DDoS protection, [lichess blog](https://lichess.org/@/thibault/blog/the-opening-explorer-now-requires-authentication/FSWh9Zg3)); limit about 20 requests/min per lichess account. When logged in with lichess the login token is used (and a failed request is retried after logging in). Otherwise the user can paste a lichess personal API token (no scopes) under Advanced ("or paste a token"); it is stored in localStorage `daisychess.explorer` (with db and filters) and sent only as `Authorization: Bearer` to `explorer.lichess.org`, never in URLs or logs and never to `lichess.org`. Without a token one request is tried; after a `401` the panel shows the token help instead of retrying.
- **Requests:** from the browser (CORS allows `Authorization`); host `https://explorer.lichess.org` is in CSP `connect-src`. Position changes are debounced 300 ms, stale requests aborted, results cached per (db, filters, start FEN + moves) for the session (LRU 200). Positions beyond 50 plies are not requested. `429` blocks requests for `Retry-After` (default 60 s; the header is not CORS-exposed) and retries automatically.
- The panel calls `setActive(true/false)` on mount/unmount, so the store only follows the game while the tab is open.
- **Fair play:** while a human game runs (`useHumanGameLock()`: a live lichess game or seek, or a game against the local engine) the panel deactivates the store (no requests, no data shown) and shows the `lockText` reason instead; it resumes when the game ends.

## Game review

- **Auto review:** `src/review/autoReview.ts` (installed by `App`) watches the game store. A load is a change that replaces `headers` or `startFen` and leaves at least 2 moves (`loadPgn`: PGN paste/file, online import); moves, takebacks, navigation, New game and FEN loads never qualify. With `settings.autoReview` on (Settings → "Analyse games automatically after loading", default on) and no game against the engine running, it resets the review store, starts `REVIEW_PRESETS.fast` with `{ auto: true }` and opens the Review tab. The panel then shows a dismissible "Auto review (fast) — run Deep for more accuracy" line; Start (or Run Deep) always restarts with the chosen preset.
- **Data:** `BatchAnalyzer` caches `eval`, `bestMove` and `pv` (UCI, at most 8 plies) per FEN and exposes the analysed `results` of a run. The review store keeps the unchanged engine-core `ReviewSummary` plus `moveDetails[ply]` (`review/details.ts`: played/best SAN, best line in SAN via `convertPv`, White-POV evals before/after, `evalIfBest`, mover-POV swing text, class), built incrementally while the review runs.
- **UI:** the Review tab shows a "Current move" card (`aria-live="polite"`) following the viewed ply: class with win-chance loss, "Better: …" with the clickable best line (board preview), eval before → after and a template sentence (`explainMove`); buttons jump to the previous/next mistake or blunder. When done: accuracy, counts, eval graph and per side "Good moves" (best/excellent, top 5) and "Moves to improve" (inaccuracy/mistake/blunder by loss). While the Review tab is open and a review exists, the board arrows are the played move (red mistake/blunder, orange inaccuracy, green otherwise) and the engine's best move (green) instead of the live-analysis arrow (`reviewShapes` in `components/Analysis/shapes.ts`).

## Tests

- `pnpm --filter @daisychess/web test` - Vitest (jsdom), components, stores, engine clients with fakes.
- `pnpm --filter @daisychess/web e2e` - Playwright. The config builds the app and serves it with `vite preview` on port 4180 (reused if already running), with COOP/COEP so the multi-threaded engine works. Specs: lichess-auth (OAuth callback with mocked lichess, explorer with the login token, logout, login redirect URL), play, play-engine (game vs the engine, premove, clocks incl. a 15-second flag; screenshot `play-clock.png`), engine (lite, single and full builds), analysis, compare, backend (real server; also the access-token flow with `ACCESS_TOKEN` on port 8584)/remote (a fake WebSocket server in the spec), review, settings, `a11y.spec.ts` (axe on the main states, fails on serious/critical violations), `perf.spec.ts` (long-task budget during rapid navigation). Screenshots go to `test-results/screenshots` (override with `E2E_SHOTS_DIR`).

## Dev hooks

`window.__daisychess` (`src/engine/devHook.ts`) exposes factories used by e2e and the console: `createWasmEngine(options)`, `createRemoteEngine(options)` and `runReview(options)`. They only lazily import the engine code, so they are harmless in production.

## Accessibility notes

Tabs follow the WAI-ARIA tabs pattern (roving tabindex, arrows/Home/End). Global arrow-key navigation of the game is skipped for inputs, selects, tabs and radios, and when a modifier is held. The board is pointer-only; the keyboard path is the move list, the FEN field and the Import tab. Colours are tokens in `packages/ui-theme/src/base.css`; `prefers-reduced-motion` disables all transitions and animations there.
