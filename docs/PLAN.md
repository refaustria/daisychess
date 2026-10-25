# DaisyChess — Plan

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

## M13 — Play live on lichess (Board API)
| ID | Task | Tier | Status |
|---|---|---|---|
| M13-1 | "Log in with lichess" (OAuth PKCE), shared token store used by Explorer and Import ("my games"), logout/revoke | senior | done |
| M13-2 | Live games via Board API: seek/challenge/AI, event + game streams, clocks, moves, draw/resign/abort, hard engine lock during a live game, auto review afterwards | senior | done |
| M13-3 | Incoming challenges and ongoing games shown on open; Live tab wiring in App | senior | done |
| M13-4 | Log in with a pasted personal access token (board:play, challenge:*) as alternative to OAuth; no revoke on logout for pasted tokens | worker | done |

## M14 — Clocks and time controls for local play
| ID | Task | Tier | Status |
|---|---|---|---|
| M14-1 | Shared `Clock` component (mm:ss, tenths under 10 s, hours for long games, low-time state) used by Live and Play; time-control presets with categories (Bullet/Blitz/Rapid/Classical, lichess rules) and custom; play vs engine with both clocks running, increment, flag = loss on time, engine thinking time derived from its remaining time; premove setting applied to local play | senior | done |

## M15 — Board-centric layout with prominent clocks (requested 2026-10-23)
| ID | Task | Tier | Status |
|---|---|---|---|
| M15-1 | Player bars with large clocks above and below the board (names/ratings from live, engine play or PGN headers), side panel (moves, play, live, …) moved to the left with more width; mobile stacks board + bars then panel | senior | done |
| M15-2 | Captured pieces as small icons in each player bar + material advantage (+n; P1 N3 B3 R5 Q7 as requested) | worker | done |
| M15-3 | Side panel back on the right; slimmer player bars and tighter vertical spacing so the board regains height | worker | done |
| M15-4 | iPad Safari: dynamic viewport height (dvh) so the bottom player bar stays visible | worker | done |

## M16 — Play a friend via link (own server, nickname, no account)
| ID | Task | Tier | Status |
|---|---|---|---|
| M16-1 | Protocol (ADR-013) + server: rooms over the existing WebSocket, server-side move validation and clocks, reconnect token, draw/resign/abort/claim, limits; works without the engine access token | architect | done |
| M16-2 | Web: "Friend" play mode — create link with nickname/time control/colour, join via link with nickname, board + clocks, fair-play engine lock, result + auto review | senior | done |

## M17 — Game review on the server (requested 2026-10-25)
| ID | Task | Tier | Status |
|---|---|---|---|
| M17-1 | Review engine setting (browser / server, default server when configured and reachable), review runs through the remote engine with the server's max threads, fallback to WASM with a notice; progress shows where it runs | senior | done |

## M18 — Openings trainer (decided 2026-10-25: drill + play-out first, library and repertoire later)
| ID | Task | Tier | Status |
|---|---|---|---|
| M18-1 | Openings data with move lines (generator keeps the PGN of each variation), book model (book moves at a position, named sub-variations), Openings tab: opening search/picker, line walk-through, Drill mode (user plays one side, app plays book moves, engine-checked feedback on deviations, retry, mistake memory with spaced repetition) | senior | done |
| M18-2 | Play vs engine from the current position (keeps the moves so far in the game, review covers the whole game) as the hand-off from the drill | worker | done |
| M18-3 | Review with opening focus: "left the book at move N, book move was …, eval swing"; drill → play-out → review flow wired end-to-end; summary of drill results | senior | done |
| M18-4 | Opening library view (engine eval, alternatives, explorer stats per move) | senior | todo |
| M18-5 | Repertoire from imported games: openings played, win rates, first deviation from book, training recommendations | senior | todo |

## M19 — Browser engine memory (bug reported 2026-10-25: "Stockfish worker error: RangeError: Out of memory" on iPad)
| ID | Task | Tier | Status |
|---|---|---|---|
| M19-1 | At most one shared browser engine for batch work (review + drill), idle disposal, live engine released while paused on memory-constrained devices, iOS thread cap, OOM recovery (recreate smaller, single notice, no error loop) | senior | done |

## M20 — Review follow-ups (requested 2026-10-25)
| ID | Task | Tier | Status |
|---|---|---|---|
| M20-1 | Persistent review cache (IndexedDB) keyed by game + preset; a loaded game that was reviewed shows its review instantly; no re-run with the same or weaker preset; Deep after Fast only searches what is missing | senior | done |
| M20-2 | Guided tour after a review: auto-play through the game pausing on great moves, mistakes and blunders with arrows and commentary; play/pause/skip; any user navigation ends the tour | worker | done |
| M20-3 | Server-side review store (ADR-017): SQLite next to the engine server, keyed by game hash, moves + evaluations only (no headers), `review.get` open / `review.put` token-only, size limit configurable via env `REVIEW_STORE_MAX_BYTES` (default 5 GB, owner decision 2026-10-25) with LRU eviction, so it can be tuned for a public release; client reads local cache first, then server, writes both; shared position evaluations for Deep-after-Fast | architect | done |

## M21 — Rename to DaisyChess (requested 2026-10-25)
| ID | Task | Tier | Status |
|---|---|---|---|
| M21-1 | Rename ChessLab → DaisyChess everywhere: UI (title, header with logo), README/docs/runbook, daisy SVG logo + favicons/apple-touch-icon, package scope `@daisychess/*`, storage keys `daisychess.*` with one-time migration, systemd unit `daisychess-server` (deploy script retires the old unit), lichess OAuth client id; domain unchanged | senior | done |
