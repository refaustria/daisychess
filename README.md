# ChessLab — Browser & Server Chess Analysis

A modern, minimal chess analysis web app. Play a game yourself or import a PGN, and let Stockfish (or other UCI engines) evaluate every position with a live evaluation bar, best-move suggestions and full-game analysis.

Two analysis backends are offered and can be switched at runtime:

- **Browser mode** — Stockfish compiled to WebAssembly runs in a Web Worker on the user's machine. No server required.
- **Server mode** — native Stockfish (and optionally other engines) runs on a dedicated machine and streams results over WebSocket. Stronger, faster, multi-threaded.

> **For Claude Code:** this repository is run by an orchestrating Claude Code session that acts as project manager only. It does not implement features itself; it plans, delegates to sub-agents, reviews and integrates. See [`CLAUDE.md`](./CLAUDE.md) and the section *Working Model for Claude Code* below.

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
- **Routing/pages:** `/` (play & analyze), `/review/:id` (game review), `/settings`.

Browser engine builds to support (from the `stockfish` npm package, Stockfish 18):

| Build | Size | Needs COOP/COEP headers | Use |
|---|---|---|---|
| `lite-single` | small | no | default, works everywhere |
| `lite` (multi-thread) | small | yes | if headers available |
| `full` (multi-thread, big NNUE) | ~75 MB | yes | opt-in "maximum strength" |

The site must set `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` in production to unlock `SharedArrayBuffer` for multi-threaded WASM. Detect support at runtime and fall back gracefully.

### 2.2 Server (`apps/server`)

- **Node.js 20 + TypeScript**, `ws` for WebSocket, `fastify` for health/REST endpoints.
- Spawns native engine processes (child_process) and speaks UCI over stdin/stdout.
- **Engine pool:** N engine instances per engine type; sessions are leased per client, with idle timeout and hard limits on depth/time/MultiPV to protect the machine.
- **Engine registry** (`engines.json`): name, binary path, NNUE path, default options (Threads, Hash), enabled flag. Stockfish 18 is the default; others (e.g. Lc0, Fairy-Stockfish) are optional.
- **Setup script** `scripts/fetch-engines.sh` downloads/compiles engines for the host CPU (x86-64 AVX2 / BMI2 / Apple Silicon detection).
- Dockerfile + `docker-compose.yml` for one-command deployment.

### 2.3 Protocol (browser ⇄ server)

JSON over WebSocket. Mirrors UCI so that `engine-core` can parse both local and remote output with the same code.

```jsonc
// client → server
{ "type": "analyze", "sessionId": "...", "engine": "stockfish-18", "fen": "...", "multipv": 3, "depth": 24 }
{ "type": "stop", "sessionId": "..." }

// server → client (streamed)
{ "type": "info", "sessionId": "...", "depth": 18, "multipv": 1, "score": { "cp": 35 }, "pv": ["e2e4","e7e5"], "nps": 1200000 }
{ "type": "bestmove", "sessionId": "...", "move": "e2e4" }
{ "type": "error", "sessionId": "...", "message": "..." }
```

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
- Move list with variations; keyboard navigation (←/→/Home/End); FEN copy.

### Game review
- Batch-analyze every position at configurable depth (server mode recommended).
- Per-move classification and accuracy %, eval graph over the game, "key moments" list.
- Export the annotated PGN.

### Customization
- Board colors (presets + custom picker), piece sets (cburnett, merida, alpha, …), coordinates on/off, highlight style, sound on/off, dark/light mode.
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

```bash
pnpm install
pnpm dev:web        # http://localhost:5180 (see docs/DECISIONS.md ADR-001)
pnpm dev:server     # http://127.0.0.1:8580 (requires engines, see below)
pnpm fetch-engines  # downloads native Stockfish 18 + NNUE into ./engines
pnpm test
pnpm build
```

Server mode via Docker:

```bash
docker compose -f docker/docker-compose.yml up --build
```

Environment variables (`apps/server/.env.example`): `PORT`, `MAX_SESSIONS`, `MAX_DEPTH`, `MAX_THREADS`, `ENGINES_CONFIG`.

---

## 7. Licenses

Stockfish and Fairy-Stockfish are GPLv3; shipping their binaries or WASM builds makes this project GPLv3 as well. `chessground` is GPLv3, `chess.js` is BSD-2. This repository is licensed under **GPLv3**.
