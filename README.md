# ChessLab — Browser & Server Chess Analysis

A modern, minimal chess analysis web app. Play a game yourself or import a PGN, and let Stockfish (or other UCI engines) evaluate every position with a live evaluation bar, best-move suggestions and full-game analysis.

Two analysis backends are offered and can be switched at runtime:

- **Browser mode** — Stockfish compiled to WebAssembly runs in a Web Worker on the user's machine. No server required.
- **Server mode** — native Stockfish (and optionally other engines) runs on a dedicated machine and streams results over WebSocket. Stronger, faster, multi-threaded.

> **For Claude Code:** this repository is run by an orchestrating Claude Code session that acts as project manager only. It does not implement features itself; it plans, delegates to sub-agents, reviews and integrates. See [`CLAUDE.md`](./CLAUDE.md) and the section *Working Model for Claude Code* below.

## Status

All milestones M0–M10 are implemented (play, browser and server analysis, game review, play vs engine, online import, theming, hardening); the live site is https://c.referee.at. Task-level status is in [`docs/PLAN.md`](./docs/PLAN.md), design decisions in [`docs/DECISIONS.md`](./docs/DECISIONS.md) (ADR-001..), the threat model in [`docs/SECURITY.md`](./docs/SECURITY.md), deployment in [`deploy/README.md`](./deploy/README.md) and `docker/`.

| Area | State |
|---|---|
| Play (board, move list, undo, flip, FEN/PGN import, keyboard navigation) | done |
| Browser engine (Stockfish 19 WASM, MultiPV, eval bar, arrows, line preview) | done |
| Server engine (native Stockfish 19, WebSocket, limits, Origin check) | done |
| Game review (accuracy, eval graph, key moments, annotated PGN export) | done |
| Engine registry and multi-engine comparison | done (Stockfish only; other UCI engines are configurable on the server but none are shipped) |
| Theming (board colours, piece sets Cburnett/Letters, coordinates, highlights, sounds, dark/light) | done |
| Accessibility / performance pass | done (axe e2e checks, keyboard-operable tabs; the board itself is mouse/touch only) |
| Play a friend via link (rooms on the server: nickname, time control, colour; reconnect, draw/resign/abort/claim, spectators) | server done (ADR-013); web UI in progress (M16-2) |
| Opening database, accounts | not built (non-goals for v1) |

---

## 1. Goals

| Goal | Description |
|---|---|
| Play | Drag-and-drop board, legal-move highlighting, undo, flip, move list with SAN notation |
| Import | Load PGN (file upload or paste), FEN input, navigate with keyboard arrows |
| Analyze | Live engine evaluation of the current position, top-N lines (MultiPV), best-move arrows |
| Eval bar | Vertical bar next to the board, centipawn → win-probability mapping, mate display (M3) |
| Game review | Analyze all moves of a game, classify (best / good / inaccuracy / mistake / blunder), accuracy per side |
| Engines | Pluggable engine registry; enable/disable engines, run several in parallel for comparison |
| Backends | Switch between browser (WASM) and server (native) analysis at any time |
| Look & feel | Clean, modern board (Lichess-like default: brown/beige squares, cburnett pieces); themes for colors, pieces, coordinates, dark/light UI |

Non-goals (for v1): online multiplayer, user accounts, opening database, cloud storage.

---

## 2. Architecture

```
chesslab/
├── apps/
│   ├── web/                 # Vite + React + TypeScript frontend
│   └── server/              # Node.js (TypeScript) engine server, WebSocket API
├── packages/
│   ├── engine-core/         # Shared: UCI parser, Engine interface, eval types, cp→% mapping
│   └── ui-theme/            # Board/piece themes (CSS + assets)
├── engines/                 # Native engine binaries / NNUE files for the server (git-ignored, fetched by script)
├── docker/                  # Dockerfiles + compose for server mode
├── .claude/                 # Claude Code agent definitions and project memory
├── CLAUDE.md
└── README.md
```

### 2.1 Frontend (`apps/web`)

- **Vite + React 18 + TypeScript**, state via Zustand.
- **Board:** `chessground` (the Lichess board library). Pure CSS theming → easy customization.
- **Rules / notation:** `chess.js` for move generation, FEN, PGN parsing, SAN.
- **Engine access:** a single `EngineClient` interface with two implementations:
  - `WasmEngineClient` — loads a WASM engine inside a Web Worker.
  - `RemoteEngineClient` — talks to the server over WebSocket.
- **Layout:** a single page (`/`): board + eval bar, engine panel, and tabs for Moves, Play, Import, Review and Settings (Review and Settings are lazy-loaded). There is no router.
- Structure and dev hooks: [`apps/web/README.md`](./apps/web/README.md).

Browser engine builds (from the `stockfish` npm package, Stockfish 19; the two lite builds plus the `full` build as an opt-in download):

| Build | Size | Needs COOP/COEP headers | Use |
|---|---|---|---|
| `lite-single` | small | no | default, works everywhere |
| `lite` (multi-thread) | small | yes | if headers available |
| `full` (multi-thread, big NNUE) | ~75 MB | yes | not shipped (idea: opt-in "maximum strength") |

The site must set `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` in production to unlock `SharedArrayBuffer` for multi-threaded WASM. Detect support at runtime and fall back gracefully.

### 2.2 Server (`apps/server`)

- **Node.js 20 + TypeScript**, `ws` for WebSocket, `fastify` for health/REST endpoints.
- Spawns native engine processes (child_process) and speaks UCI over stdin/stdout.
- **Engine pool:** N engine instances per engine type; sessions are leased per client, with idle timeout and hard limits on depth/time/MultiPV to protect the machine.
- **Engine registry** (`engines.json`): name, binary path, NNUE path, default options (Threads, Hash), enabled flag. Stockfish 19 is the default (official "universal" Linux build, picks the instruction set at runtime); others (e.g. Lc0, Fairy-Stockfish) are optional.
- **Setup script** `scripts/fetch-engines.sh` downloads/compiles engines for the host CPU (x86-64 AVX2 / BMI2 / Apple Silicon detection).
- Dockerfile + `docker-compose.yml` for one-command deployment.

### 2.3 Protocol (browser ⇄ server)

JSON text frames over WebSocket (`/ws`), one message per frame, discriminated by `type`. The schemas, types and parsers live in `packages/engine-core/src/protocol.ts` (Zod); the design is recorded in ADR-006. `PROTOCOL_VERSION` is carried by `hello`/`welcome`; a mismatch is answered with `error: protocol_mismatch`.

```jsonc
// client → server
{ "type": "hello", "protocolVersion": 1, "client": { "name": "chesslab-web", "version": "0.1.0" }, "token": "…" }  // token only if the server sets ACCESS_TOKEN
{ "type": "analyze", "sessionId": "tab-1", "searchId": 7, "engine": "stockfish", "fen": "...",
  "multipv": 3, "depth": 24, "movetime": 5000, "threads": 4, "hash": 256 }   // all after fen optional; no depth/movetime = infinite
{ "type": "stop", "sessionId": "tab-1" }        // stops the running search, bestmove follows
{ "type": "release", "sessionId": "tab-1" }     // frees the leased engine instance
{ "type": "ping", "t": 1700000000000 }

// server → client
{ "type": "welcome", "protocolVersion": 1, "serverVersion": "0.1.0",
  "limits": { "maxDepth": 30, "maxMultipv": 5, "maxThreads": 4, "maxHash": 512, "maxMovetimeMs": 600000, "maxSessionsPerConnection": 2 },
  "engines": [{ "id": "stockfish", "name": "Stockfish 19", "enabled": true, "defaults": { "threads": 4, "hash": 256 } }] }
{ "type": "info", "sessionId": "tab-1", "searchId": 7,
  "info": { "depth": 18, "multipv": 1, "score": { "cp": 35 }, "pv": ["e2e4", "e7e5"], "nps": 1200000 } }  // score = side to move (raw UCI)
{ "type": "bestmove", "sessionId": "tab-1", "searchId": 7, "bestMove": { "move": "e2e4", "ponder": "e7e5" }, "reason": "completed" }
{ "type": "error", "code": "limit_exceeded", "message": "depth 40 exceeds the server limit of 30", "sessionId": "tab-1", "searchId": 8 }
{ "type": "pong", "t": 1700000000000 }
```

- A **session** (`sessionId`, client-chosen) leases one engine instance; it is created by the first `analyze`, freed by `release`, by an idle timeout or when the socket closes. Several sessions per connection allow multi-engine comparison, bounded by `limits.maxSessionsPerConnection`.
- Each `analyze` starts a **search** (`searchId`, client-chosen, unique per session). A new `analyze` on a session with a running search stops it first; every accepted search ends with exactly one `bestmove` (or an `error` carrying its `searchId`).
- `info` scores are side-to-move, like UCI; the client converts with `infoToWhitePov` exactly as the WASM client does.
- **Access token** (optional, ADR-010/013): a server started with `ACCESS_TOKEN` answers a `hello` without the matching `token` (max 256 chars, compared in constant time) with a *restricted* `welcome` — `engines: []`, `capabilities: { analysis: false, rooms: true }` — and rejects every `analyze` with `error: unauthorized`; rooms work without the token. With the token (or on a public server) `capabilities` is `{ analysis: true, rooms: true }`. Additive: `PROTOCOL_VERSION` stays 1.
- Error codes: `invalid_message`, `protocol_mismatch`, `handshake_required`, `unknown_engine`, `limit_exceeded`, `no_capacity`, `session_not_found`, `engine_crashed`, `rate_limited`, `internal_error`, `unauthorized`, `forbidden` (analysis while playing in a room).

**Rooms — play a friend via link** (ADR-013, additive `room.*` messages on the same socket). The server validates moves (chess.js), runs the clocks and sends the full `room.state` snapshot to every member after each change; room-level failures come as `room.error`.

```jsonc
// client → server (all but room.create carry roomId; one room per connection)
{ "type": "room.create", "nick": "Alice", "clock": { "initialMs": 180000, "incrementMs": 2000 }, "color": "random" }  // clock: null = no clock
{ "type": "room.join", "roomId": "…", "nick": "Bob" }            // takes the free seat (game starts) or spectates; without nick: spectate only
{ "type": "room.attach", "roomId": "…", "playerToken": "…" }    // reconnect / reload with the token from room.seat
{ "type": "room.move", "roomId": "…", "uci": "e7e8q" }
{ "type": "room.resign" | "room.abort" | "room.claim" | "room.leave", "roomId": "…" }
{ "type": "room.draw", "roomId": "…", "action": "offer" | "accept" | "decline" }

// server → client
{ "type": "room.seat", "roomId": "…", "playerToken": "…", "color": "white" }   // on create / join with a free seat
{ "type": "room.state", "roomId": "…", "status": "playing", "you": "white", "spectators": 0,
  "players": { "white": { "nick": "Alice", "connected": true }, "black": { "nick": "Bob", "connected": false } },
  "startFen": "…", "fen": "…", "moves": ["e2e4", "e7e5"],
  "clock": { "initialMs": 180000, "incrementMs": 2000, "white": 171000, "black": 180000, "running": "white" },  // null without a clock
  "drawOffer": "black", "claimableAt": 1700000060000, "result": "1-0", "reason": "timeout", "serverTime": 1700000000000 }
{ "type": "room.error", "roomId": "…", "code": "not_your_turn", "message": "it is not your turn" }
```

- Link: `https://c.referee.at/#/room/<roomId>` (22 URL-safe chars, 128 random bits). The `playerToken` (43 chars, 256 bits) is kept in `localStorage`, never in the URL.
- Clocks: Fischer increment; the first two plies are untimed; from the third the server charges on move arrival and flags (`reason: timeout`; a draw if the opponent cannot mate). Displayed time of `clock.running` = `clock[running] - (now - receivedAt)`.
- Disconnects: the seat stays, the clock runs; the opponent may `room.claim` from `claimableAt` (60 s); both gone → `abandoned`. `abort` only before both sides moved; `reason` is one of `checkmate stalemate draw resign timeout abort abandoned agreement` (no `result` = no game was played).
- Fair play: a player in a running room gets `forbidden` on `analyze`. Limits: `ROOM_MAX_ROOMS` 200, 10 creations / 10 min per address, waiting rooms expire after 15 min, finished rooms are kept 10 min, 10 spectators per room, nick 1–20 chars.
- `room.error` codes: `room_not_found`, `room_full`, `bad_token`, `not_a_player`, `not_your_turn`, `illegal_move`, `bad_state`, `too_many_rooms`.

### 2.4 Shared (`packages/engine-core`)

- `Engine` interface: `load()`, `setOptions()`, `analyze(fen, {depth, movetime, multipv})` → async iterable of `EngineInfo`, `stop()`, `dispose()`.
- UCI line parser (`info … score cp/mate … pv …`, `bestmove`).
- `cpToWinProbability(cp)` using the Lichess sigmoid (`50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)`), mate handling, eval-bar clamping.
- Move classification thresholds for game review.

---

## 3. Features in Detail

### Evaluation bar
- Vertical bar beside the board, white share from the bottom, animated transitions.
- Shows numeric eval (`+0.3`, `-1.7`, `M4`), always from White's perspective, flips with the board.

### Live analysis panel
- Engine selector (per backend), depth/time control, MultiPV 1–5, threads/hash (server mode).
- Each line: eval, depth, moves in SAN; click a line to preview it on the board; hover shows arrow.
- Multiple engines can run simultaneously and are shown as separate tabs/columns.

### PGN import & navigation
- Drop a `.pgn` file or paste text; multi-game files show a picker.
- Move list (main line, no variations yet); keyboard navigation (←/→/Home/End); FEN copy.

### Play vs engine
- Play tab: pick colour, strength (Elo presets) and thinking time; promotion dialog, takeback, resign, rematch, "Review this game". Live analysis and Review are paused during a game; loading a position or PGN aborts it.

### Online import
- Import tab: fetch recent games of a user from the lichess and chess.com public APIs.

### Engine access
- Settings tab: server access token (sent as `hello.token`; the server enforces it with `ACCESS_TOKEN`). Opt-in full-strength browser build (`wasm:full`, ~99 MB, one-time download confirmation).

### Game review
- Batch-analyze every position at configurable depth (server mode recommended).
- Per-move classification and accuracy %, eval graph over the game, "key moments" list.
- Export the annotated PGN.

### Customization
- Board colors (presets + custom picker), piece sets (Cburnett, Letters), coordinates on/off, highlight style, sound on/off, dark/light mode.
- Stored in `localStorage`.

---

## 4. Milestones

| # | Milestone | Deliverable |
|---|---|---|
| M0 | Repo scaffold | pnpm workspace, lint/format/test setup, CI (GitHub Actions), `engine-core` skeleton |
| M1 | Play | Board, legal moves, move list, flip/undo, FEN/PGN import, keyboard navigation |
| M2 | Browser engine | WASM Stockfish worker, `WasmEngineClient`, eval bar, MultiPV panel, arrows |
| M3 | Server engine | `apps/server`, engine pool, WebSocket protocol, `RemoteEngineClient`, backend switch in UI |
| M4 | Game review | Batch analysis, move classification, accuracy, eval graph, annotated PGN export |
| M5 | Engines & themes | Engine registry (browser + server), multi-engine comparison, theming UI |
| M6 | Polish & deploy | COOP/COEP hosting, Docker image, docs, performance pass, accessibility |

Each milestone is broken into GitHub issues by the orchestrator before any implementation starts.

---

## 5. Working Model for Claude Code

The Claude Code session in this repo is the **project manager / orchestrator**. Its job:

1. Keep the plan (milestones → issues) current and in `docs/PLAN.md`.
2. Break work into well-scoped tasks with acceptance criteria.
3. Delegate every implementation task to a sub-agent; never write feature code in the orchestrator session.
4. Review returned work (diff, tests, lint), request fixes, then integrate and commit.
5. Record decisions in `docs/DECISIONS.md` (ADR style).

### Agent tiers and model routing

| Tier | Model | Use for |
|---|---|---|
| `worker` | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | Regular tasks: components, tests, styling, docs, small bug fixes, scripts |
| `senior` | Claude Opus 5.5 (`claude-opus-5-5`) | Hard tasks: engine pool & concurrency, WebSocket protocol, WASM worker integration, performance work, tricky bugs |
| `architect` | Claude Fable 5.1 (`claude-fable-5-1`) | Architecture, cross-cutting design, protocol decisions, security review, anything the senior tier failed on twice |

Routing rules:
- Default to `worker`. Escalate to `senior` when the task touches concurrency, process management, engine protocols, or performance.
- Use `architect` for any task that changes interfaces in `packages/engine-core`, the WebSocket protocol, or the repo structure — and for unblocking tasks after two failed attempts.
- One task per agent run; agents receive the task description, acceptance criteria, relevant file paths and the coding conventions below. They return a summary, the diff, and test results.

Sub-agent definitions live in `.claude/agents/` (one file per tier with its model set). See `CLAUDE.md` for the exact prompts and conventions.

### Definition of Done (every task)
- Code compiles, `pnpm lint` and `pnpm test` pass.
- New behavior has tests (unit for `engine-core`, component tests for UI, integration for server).
- No console errors; no new `any` types without justification.
- Commit message follows Conventional Commits.

---

## 6. Development

Requirements: Node >= 20, pnpm. Ports: web dev server **5180**, engine server **8580** (ADR-001); Docker publishes the UI on 8080.

```bash
pnpm install
pnpm fetch-engines  # downloads native Stockfish 19 (NNUE embedded, checksum-verified) into ./engines
pnpm dev:web        # http://localhost:5180 (browser mode works without the server)
pnpm dev:server     # http://127.0.0.1:8580 (/ws, /health); needs the engines above
pnpm lint           # eslint + typecheck of all packages
pnpm test           # Vitest, all packages
pnpm e2e            # Playwright (builds the web app, serves it on :4180); first run: pnpm --filter @chesslab/web exec playwright install chromium
pnpm build
```

Server configuration is read from the environment (see `apps/server/.env.example`; no `.env` auto-loading, use `node --env-file`):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8580` / `127.0.0.1` | listen address |
| `ALLOWED_ORIGINS` | same host as the request | comma-separated `scheme://host[:port]` allowed to open `/ws`, or `*` (ADR-008); production sets `https://c.referee.at` |
| `MAX_SESSIONS` | `4` | global cap on leased engine instances |
| `MAX_SESSIONS_PER_IP` | unset | per-client-address cap, must not exceed `MAX_SESSIONS` |
| `MAX_SESSIONS_PER_CONNECTION`, `MAX_DEPTH`, `MAX_MULTIPV`, `MAX_THREADS`, `MAX_HASH_MB`, `MAX_MOVETIME_MS` | see `.env.example` | per-request limits announced in `welcome.limits` |
| `ENGINE_IDLE_MS`, `SESSION_IDLE_MS` | `300000`, `600000` | idle timeouts |
| `ENGINES_CONFIG` | `apps/server/engines.json` | engine registry |
| `LOG_LEVEL` | `info` | pino level |
| `ACCESS_TOKEN` | unset (public) | shared token for analysis (ADR-010); without it clients are restricted to rooms (ADR-013) |
| `ROOM_MAX_ROOMS`, `ROOM_MAX_SPECTATORS`, `ROOM_CREATE_PER_IP`, `ROOM_CREATE_WINDOW_MS`, `ROOM_WAITING_TTL_MS`, `ROOM_FINISHED_TTL_MS`, `ROOM_IDLE_TTL_MS`, `ROOM_CLAIM_GRACE_MS` | `200`, `10`, `10`, `600000`, `900000`, `600000`, `7200000`, `60000` | room limits and lifetimes (ADR-013) |

### Deployment

- Production (nginx + Let's Encrypt, systemd unit, COOP/COEP): [`deploy/README.md`](./deploy/README.md).
- Docker (server mode in one command):

```bash
docker compose -f docker/docker-compose.yml up --build -d   # web UI + /ws + /health on http://localhost:8080
docker compose -f docker/docker-compose.yml down
```

`server` (`docker/server.Dockerfile`) runs Node 22 with Stockfish fetched at build time (`STOCKFISH_VERSION` / `STOCKFISH_ARCH` build args) as non-root under `tini`; port 8580 is only reachable inside the compose network. `web` (`docker/web.Dockerfile`, `docker/nginx.web.conf`) serves the build with COOP/COEP headers and proxies `/ws` and `/health`. Configure with `docker/server.env`; the registry is `docker/engines.docker.json`.

---

## 7. Licenses

Stockfish and Fairy-Stockfish are GPLv3; shipping their binaries or WASM builds makes this project GPLv3 as well. `chessground` is GPLv3, `chess.js` is BSD-2. This repository is licensed under **GPLv3**.
