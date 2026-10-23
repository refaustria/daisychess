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
| M3-4 | `RemoteEngineClient` + backend switch in UI | senior | done |
| M3-5 | systemd unit + deploy of server on this host | worker | done |

## M4 — Game review
| ID | Task | Tier | Status |
|---|---|---|---|
| M4-1 | Batch analysis runner (both backends) | senior | done |
| M4-2 | Move classification + accuracy in `engine-core` (tested) | worker | done |
| M4-3 | Review UI: eval graph, key moments, annotated PGN export | worker | done |

## M5 — Engines & themes
| ID | Task | Tier | Status |
|---|---|---|---|
| M5-1 | Engine registry (browser + server), enable/disable, multi-engine comparison tabs | senior | done |
| M5-2 | Theming UI: board colors, piece sets, coordinates, sounds, persisted in localStorage | worker | done |

## M6 — Polish & deploy
| ID | Task | Tier | Status |
|---|---|---|---|
| M6-1 | Docker image + compose for server mode | worker | done |
| M6-2 | Performance pass, accessibility, docs | worker | done |
| M6-3 | Security review of server + hosting — `docs/SECURITY.md`, ADR-008 (Origin check), Stockfish-safe FEN validation, verified engine downloads, systemd/nginx/docker hardening; P1–P3 follow-ups listed in SECURITY.md | architect | done |

## M7 — Online game import (lichess, chess.com)
| ID | Task | Tier | Status |
|---|---|---|---|
| M7-1 | Fetch a user's recent games from lichess and chess.com public APIs, pick a game, load PGN into the app, run review | worker | done |

## M8 — Play against the engine
| ID | Task | Tier | Status |
|---|---|---|---|
| M8-1 | Play mode: colour, strength (Elo/skill), time per move, engine moves via WASM, promotion dialog, resign/takeback, game-over handling | senior | done |

## M9 — Product follow-ups (decided 2026-10-23)
| ID | Task | Tier | Status |
|---|---|---|---|
| M9-1 | Per-engine analysis settings (depth, MultiPV, threads per enabled engine) | senior | done |
| M9-2 | Server access token (`ACCESS_TOKEN`, `hello.token`, Settings field) | senior | done |
| M9-3 | Full-NNUE WASM build as opt-in "maximum strength" engine | senior | done |
| M9-4 | CI: deterministic tests (hardwareConcurrency), Stockfish fetch + cache in the e2e job | worker | done |

## M10 — Security backlog P2/P3
| ID | Task | Tier | Status |
|---|---|---|---|
| M10-1 | CSP for the SPA, HSTS, Docker base-image digests, GitHub Actions pinned by SHA, abuse logging | senior | done |
| M10-2 | Hash-change throttling, IP-log hashing (deferred) | senior | todo |

## M11 — Automatic analysis with suggestions
| ID | Task | Tier | Status |
|---|---|---|---|
| M11-1 | Auto-review after loading a game (setting, default on, Fast preset) + per-move commentary: played vs. better move with the best line, eval swing, arrows at the current ply; summary of good/bad moves | senior | done |

## M12 — Opening and position explorer
| ID | Task | Tier | Status |
|---|---|---|---|
| M12-1 | Opening name + ECO from a vendored lichess/chess-openings table, shown live while playing/navigating | worker | done |
| M12-2 | Position explorer (lichess masters + lichess DB): games count, W/D/L, popular moves, recent/top games with players, date, winner; load a game from the list | senior | done |
