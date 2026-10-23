# ChessLab — Plan

Status legend: `todo` · `in-progress` · `review` · `done` · `blocked`

Deployment target: **https://c.referee.at** (this host, nginx + certbot). Chess server listens on `127.0.0.1:8580` (8080 is taken by another service on the host). Web dev server uses port 5180 (5173 is taken).

## M0 — Repo scaffold
| ID | Task | Tier | Status |
|---|---|---|---|
| M0-1 | pnpm workspace, TS strict, ESLint + Prettier, Vitest, root scripts, `.gitignore`, CI (GitHub Actions) | worker | done |
| M0-2 | `engine-core` skeleton: types, `cpToWinProbability`, eval formatting, UCI info/bestmove parser, unit tests | worker | done |
| M0-3 | `apps/web` minimal Vite+React app, `apps/server` Fastify `/health`, `ui-theme` base CSS variables | worker | done |
| M0-4 | Hosting: nginx vhost `c.referee.at` + Let's Encrypt, COOP/COEP headers, `/ws` proxy, placeholder page, `deploy/` scripts | senior | done |

## M1 — Play
| ID | Task | Tier | Status |
|---|---|---|---|
| M1-1 | Game store (Zustand) wrapping chess.js: moves, undo, navigation, FEN/PGN load | worker | done |
| M1-2 | Board component with chessground: legal moves, drag & drop, flip, last-move highlight | worker | done |
| M1-3 | Move list with SAN, click-to-navigate, keyboard ←/→/Home/End | worker | done |
| M1-4 | FEN input + PGN import (paste/file, multi-game picker) | worker | done |
| M1-5 | App layout + basic light/dark theme via `ui-theme`; first deploy to c.referee.at | worker | done |

## M2 — Browser engine
| ID | Task | Tier | Status |
|---|---|---|---|
| M2-1 | `WasmEngineClient` (stockfish npm, Web Worker, lite-single default, multi-thread when `crossOriginIsolated`) | senior | done |
| M2-2 | Eval bar component (win-prob mapping, mate display, flip with board) | senior | done |
| M2-3 | Analysis panel: MultiPV lines, depth/time control, click-to-preview, best-move arrows | worker | done |

## M3 — Server engine
| ID | Task | Tier | Status |
|---|---|---|---|
| M3-1 | WebSocket protocol schema (Zod) in `engine-core`; ADR-006 | architect | done |
| M3-2 | `apps/server`: UCI process wrapper, engine pool, session leasing, limits | senior | done |
| M3-3 | `scripts/fetch-engines.sh` (host CPU: sse41-popcnt, no AVX2 on this VM) + `engines.json` + registry loader | worker | done |
| M3-4 | `RemoteEngineClient` + backend switch in UI | senior | todo |
| M3-5 | systemd unit + deploy of server on this host | worker | todo |

## M4 — Game review
| ID | Task | Tier | Status |
|---|---|---|---|
| M4-1 | Batch analysis runner (both backends) | senior | done |
| M4-2 | Move classification + accuracy in `engine-core` (tested) | worker | done |
| M4-3 | Review UI: eval graph, key moments, annotated PGN export | worker | in-progress |

## M5 — Engines & themes
| ID | Task | Tier | Status |
|---|---|---|---|
| M5-1 | Engine registry (browser + server), enable/disable, multi-engine comparison tabs | senior | todo |
| M5-2 | Theming UI: board colors, piece sets, coordinates, sounds, persisted in localStorage | worker | done |

## M6 — Polish & deploy
| ID | Task | Tier | Status |
|---|---|---|---|
| M6-1 | Docker image + compose for server mode | worker | todo |
| M6-2 | Performance pass, accessibility, docs | worker | todo |
| M6-3 | Security review of server + hosting | architect | todo |
