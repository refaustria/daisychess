# DaisyChess — Plan

Status legend: `todo` · `in-progress` · `review` · `done` · `blocked`

Deployment target: **https://play.daisychess.org** (app, portal, `/ws`) and **https://daisychess.org** (community site), this host, nginx + certbot (ADR-021; c.referee.at is retired). Chess server listens on `127.0.0.1:8580` (8080 is taken by another service on the host). Web dev server uses port 5180 (5173 is taken).

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
| M10-2 | Hash-change throttling, IP-log hashing (deferred) | senior | done (hash-change throttling superseded; IP hashing via M24-15) |

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
| M20-4 | Engine-load failures during review/drill/play surface as errors (no silent idle, no unhandled rejection), browser→server fallback, WebAssembly SIMD/threads capability probe with picker reasons | senior | done |

## M21 — Rename to DaisyChess (requested 2026-10-25)
| ID | Task | Tier | Status |
|---|---|---|---|
| M21-1 | Rename ChessLab → DaisyChess everywhere: UI (title, header with logo), README/docs/runbook, daisy SVG logo + favicons/apple-touch-icon, package scope `@daisychess/*`, storage keys `daisychess.*` with one-time migration, systemd unit `daisychess-server` (deploy script retires the old unit), lichess OAuth client id; domain unchanged | senior | done |

## M22 — Clock times from imported games (requested 2026-10-25)
| ID | Task | Tier | Status |
|---|---|---|---|
| M22-1 | Parse `%clk`/`%emt` from PGN (lichess with clocks=true, chess.com), keep per-ply clock data in the game store; player bars show the remaining time at the displayed ply; review shows time spent per move, a time graph, and flags mistakes made in time trouble; summary per player (avg time, time-trouble errors) | senior | done |

## M23 — Human-like engine: Lc0 + Maia (decided 2026-10-25)
| ID | Task | Tier | Status |
|---|---|---|---|
| M23-1 | Server: build/fetch Lc0 (CPU backend, no AVX2) + Maia 1100–1900 weights (pinned, checksummed, fetch script), engine pool entries `maia-<elo>`, protocol additions (engine list with `style: human`, `nodes` limit), ADR-019 | architect | done |
| M23-2 | Web: Maia levels as opponent in Play and as drill opponent (server only, fallback message without token), strength picker "Human-like (Maia 1500)" | senior | done |
| M23-3 | Review hint: per mistake, Maia's most likely move at the player's level (rating from PGN headers or chosen), "typical at 1500" note; time-trouble aware (M22) | senior | done |
| M23-4 | Token UX: per-device wording (missing vs rejected vs unreachable), "Open Settings" button, setup link `#setup-token=` for another device | worker | done |

## M24 — Community engine nodes + hub (decided 2026-10-25: private and pool nodes, operator portal issues user tokens, nodes + hub first)
| ID | Task | Tier | Status |
|---|---|---|---|
| M24-0 | Design ADR-020: hub/node architecture, node registration (outbound WS), token model (node tokens, user tokens per node, pool), routing/relay, portal, limits, privacy, threat model, migration of the current server; task breakdown. Deliverables: `docs/DECISIONS.md` ADR-020, `docs/SECURITY.md` §6, the rows below. Order = deployable steps: M24-1…7 put the hub live with the owner's devices unaffected; 8 adds the first community node image; 9–11 the portal and the web UX; 12–15 hardening, npm and docs. Five product questions for the owner are at the end of ADR-020 | architect | done |
| M24-1 | Refactor: extract the transport-agnostic session/search/lease state machine from `ws/connection.ts` into `sessions/ClientSessions.ts` (deliver callback + peer; per-IP ledger, idle release, ordering, terminal-message guarantee); `Connection` keeps handshake/rate limits/rooms/review and talks to an `AnalysisBackend` interface with `LocalBackend` over the pool. No behaviour change | senior | done |
| | *Acceptance:* `ws.test.ts`, `rooms.test.ts`, `review.test.ts`, `EnginePool.test.ts` pass unchanged; `connection.ts` contains no `pool.acquire`/`go` logic; `node deploy/ws-smoke.mjs` against a local standalone server passes | | |
| M24-2 | Link protocol in `packages/engine-core/src/link.ts` (ADR-020 §3: `node.hello/welcome/error/status`, `client.open/msg/close/closed`, `node.drain`, `link.close`, `LINK_PROTOCOL_VERSION`, `MAX_LINK_MESSAGE_BYTES`, parsers), token format helpers (`dc1_`/`dcn_`, `formatToken/parseToken`), additive `welcome.node` and `welcome.analysisDenied` in `protocol.ts`; `sideEffects: false` for engine-core | architect | done |
| | *Acceptance:* every schema round-trips in tests incl. size and unknown-`cid` cases; `WelcomeMessageSchema` still accepts today's `welcome`; web bundle size unchanged (±1 kB) | | |
| M24-3 | `ROLE=node`: `node/NodeLink.ts` outbound link client (hello/welcome via `checkLinkCompatibility`/`nodeVersionStatus`, status every `heartbeatMs`, one `ClientSessions` per `cid` with `peer = {ip: cid, id: cid}`, a shared `UnlimitedLedger` and `limits = minLimits(client.open.limits, own)`, `client.close` → `client.closed`, SIGTERM → `node.drain` → wait ≤ `drainMs` → exit, reconnect backoff 1–60 s ±20 %, exit non-zero on `isFatalLinkEnd`), loopback `/health` only, `HUB_URL`/`NODE_TOKEN`/`POOL` config. Adds `sessions/AnalysisChannel.ts` (interface, `ClientSessions implements` it), `sessions/UnlimitedLedger.ts`, `sessions/SessionTracker.ts` (pure) and engine-core `minLimits` (ADR-020 relay layering §1, §3, §5) | senior | done |
| | *Acceptance:* tests with a fake hub (ws server): registers, relays a search end to end with correct ordering, drops info under backpressure (1 MiB, 60/s per search) but never `bestmove`, clamps hub-given limits to its own, drains on SIGTERM, exits non-zero on `bad_token`/`replaced`; `SessionTracker` unit tests (open/close sessions and searches from both message streams); `minLimits` unit-tested in engine-core; `pnpm dev:server` with `ROLE=node HUB_URL=ws://127.0.0.1:8580/link` connects to a local hub (M24-5) | | |
| M24-4 | Hub store `hub/HubStore.ts` (SQLite, ADR-020 §6: operators, nodes, tokens, usage_daily, portal_sessions, spotchecks; versioned migrations) + `hub/tokens.ts` (mint → secret shown once, `sha256` at rest, constant-time verify by id, rotate with 24 h overlap, revoke, expiry, legacy `ACCESS_TOKEN` → `local`/`full`) | senior | done |
| | *Acceptance:* unit tests for mint/verify/rotate/revoke/expiry, `kind` and tier columns, operator-scoped queries; store opens on Node 22/24 and degrades with a clear error otherwise; nothing secret is ever returned by a read API | | |
| M24-5 | Hub link server `hub/LinkServer.ts` + `hub/HubNodeLink.ts` (one per node: `cid` allocation, `client.open`, dispatch of `client.msg`/`client.closed` to `RelaySessions`, unknown-`cid` counter, loss → `onNodeLost` on every relay) + `NodeRegistry` (fed by `node.status`) + `hub/RelaySessions.ts implements AnalysisChannel` (dumb validated relay with `SessionTracker` bookkeeping; no `RemoteNodeBackend`): accept `/link` (node token via `parseToken`, `checkLinkCompatibility`, `NODE_MIN_VERSION`, newer link wins → older `link.close replaced`), relay validated frames both ways, link rate limits and the 20 KiB cap, `/health/detail.nodes` (ADR-020 relay layering §3, §6) | senior | done |
| | *Acceptance:* tests with a fake node: bad token → `node.error bad_token` + 1008; two links same id → older gets `link.close replaced`; a player's `analyze` reaches the fake node as `client.msg` and its `info`/`bestmove` reach the player unchanged; unknown `cid` ignored and counted (100/min → `rate_limited`); `RelaySessions` unit tests with a fake `LinkPort`: node loss emits exactly one `engine_crashed` per open search (incl. a search already `release`d but not yet terminated) and one per open session without a search, then nothing more; `close()` resolves on `client.closed`, on link loss and after the 2 s timeout; node disconnect in the ws test → `engine_crashed` then close 1012 | | |
| M24-6 | Router `hub/Router.ts implements AnalysisRouter` + `ws/LocalRouter.ts` (standalone: ACCESS_TOKEN check → `ClientSessions` over `LocalBackend`, lease-based `IpSessionLedger`) + `Connection` creates its `AnalysisChannel` at `hello` from the route (`ConnectionOptions.router` replaces `backend/limits/engines/accessToken`) + `hub/AccountingChannel.ts` (decorator for every hub channel incl. `local`: per-IP and per-token slots from the message stream, per-connection cap, hub-side idle timer, `UsageSink` metering of search wall time, `BudgetSource` check for pool routes → `error no_capacity "daily pool budget exhausted"`): `hello.token` → legacy/`dc1_` lookup → private nodes → pool scheduler (free share, RTT, failure penalty, sticky 10 min, `poolShare`) → composed `welcome` (`limits = minLimits(tier, node)`, `node`, `analysisDenied`), built-in node `local` = `ClientSessions` + `UnlimitedLedger` wrapped like a remote one (ADR-020 relay layering §2, §4) | senior | done |
| | *Acceptance:* routing tests cover every `analysisDenied` reason, fallback order, pool scoring, sticky, tier composition; `AccountingChannel` unit tests: slots reserved at first `analyze` and freed on `release`/session error/idle/close, per-token and per-IP caps across two channels, budget exhausted → local `no_capacity` and nothing relayed, usage recorded per ended search and on node loss; `ROLE=standalone` behaves exactly as before (full server suite green; restricted welcomes additionally carry `analysisDenied`); `ROLE=hub` with `ACCESS_TOKEN` passes `deploy/ws-smoke.mjs` unchanged | | |
| M24-7 | Deploy the hub to production: unit env `ROLE=hub`, `HUB_STORE_PATH`, nginx `/link` location with `limit_req 2r/s burst 5` + `limit_conn 5`, loopback egress proxy block (`127.0.0.1:8581` → `lichess.org/api/account`) prepared, journald retention 7 days, nightly `hub.sqlite` backup, `deploy/link-smoke.mjs`, runbook in `deploy/README.md` | worker | done via M27-3 |
| | *Acceptance:* owner's devices analyse without any change (legacy token); `node deploy/link-smoke.mjs` registers a fake node and relays one search; `/health/detail` shows `nodes: [local]`; `sudo systemd-analyze security daisychess-server` unchanged | | |
| M24-8 | Multi-arch node image: `docker/server.Dockerfile` builds amd64 (verified release asset) and arm64 (pinned Stockfish source, `ARCH=armv8`) plus Lc0/Maia for both, `ROLE` env, `docker/docker-compose.node.yml`, `.github/workflows/release.yml` (buildx, native arm runner, push to ghcr on tags, digest pins) | senior | done (arm64 verified by the release workflow) |
| | *Acceptance:* CI builds both arches and runs an integration test (image as node against a hub container: register + one search); image is read-only/non-root/no ports; `MAIA=off` works on a 1-CPU container | | |
| M24-9 | Portal API on the hub (`/api/portal/*`): lichess login (SPA PKCE → hub verifies via `LICHESS_VERIFY_URL`, discards the token, `__Host-` cookie, `X-Requested-With` CSRF, `HUB_ADMIN_LICHESS`), nodes CRUD (create → `dcn_` shown once, rename, rotate, revoke, pool toggle, `poolShare`, status), tokens CRUD (mint → `dc1_` shown once, label, nodes, pool fallback, tier, expiry, revoke → closes connections, last used), usage, admin views (all nodes, suspect flags, ban) | senior | done |
| | *Acceptance:* every route tested for auth (401), CSRF (403 without header), operator scoping (another operator's ids → 404), rate limits; secrets appear exactly once in a create response and never in GET/logs; revoking a token closes its live connection in a test | | |
| M24-10 | `apps/portal` SPA (Vite + React, ui-theme, served at `/portal/`): login, nodes list with online/offline/suspect status and "how to run a node" snippet (docker compose + `npx` with the token filled in), tokens table with copy-once dialog and setup link, usage per token/node (last 30 days), account deletion; nginx + CSP for `/portal/` | worker | done |
| | *Acceptance:* component tests for the copy-once flows; e2e: login stub → create node → create token → revoke; axe clean; works on a phone width | | |
| M24-11 | Web app: show `welcome.node` in the engine status/picker ("on *fast-box* — community node by bojan"), map `analysisDenied` to precise messages (expired, revoked, node offline, pool busy) with the Open Settings button (M23-4 wording), one-time privacy notice before the first search on a pool node, reconnect once on close code 1012 (live engines and review) before falling back to the browser | worker | done |
| | *Acceptance:* unit tests for every `analysisDenied` message and the 1012 reconnect; existing token-UX tests unchanged; notice shown once per node and persisted | | |
| M24-12 | Spot-checks and reputation: `hub/SpotCheck.ts` samples pool searches (`SPOTCHECK_RATE`, depth ≥ 10, `local` idle), re-runs on `local`, compares best move / score (50 cp, mate sign), 3 disagreements in 24 h → `suspect` (pool removal, portal flag, admin list), decay and manual clear | senior | done |
| | *Acceptance:* tests with a fake node returning wrong moves → `suspect` after 3; agreeing node never flagged; `local` CPU for checks bounded by the rate in a load test; portal shows the flag | | |
| M24-13 | `apps/node` = `@daisychess/node` npm CLI: esbuild single-file bundle of the node role, flags mirroring env, first-run verified Stockfish download (Node port of `fetch-engines.sh`, fail closed) into `DAISYCHESS_HOME`, `--engines-dir` for existing Lc0/Maia, README; `release.yml` publishes with npm provenance on tags | senior | todo |
| | *Acceptance:* `npx -y @daisychess/node --hub wss://… --token …` registers on a clean Linux and macOS machine (CI matrix) and serves a search; a tampered download aborts; package contains no secrets or test files | | |
| M24-14 | Docs: README "Run a node" and "Hub" sections, `docs/PRIVACY.md` (players: positions go to the named node) and `docs/TERMS.md` (operators) linked from portal and app, SECURITY.md §6 reconciled with the implementation, `.env.example` for all three roles, deploy README (backup, retention, egress proxy) | worker | done (legal placeholders open for the owner) |
| | *Acceptance:* every env var of ADR-020 documented; links resolve from the portal and the app's notice; `scripts/check-csp.mjs` still passes | | |
| M24-15 | Logging hygiene: daily-salted IP hash at `info` across hub and standalone (raw only at `debug`; closes M10-2), `tokenId`/`nodeId`/`cid` fields, fail2ban filter for `/link` 1008s, log-line review for secrets (grep in tests on captured logs) | worker | done |
| | *Acceptance:* a test captures logs of a full handshake + relay and asserts no token/secret/raw IP at `info`; M10-2 marked done | | |

## M25 — Open source release (decided 2026-10-25: GPL-3.0, public repo)
| ID | Task | Tier | Status |
|---|---|---|---|
| M25-1 | LICENSE (GPL-3.0), third-party notices (Stockfish, Lc0, Maia, chessground GPL, openings CC0), secret scan of the full git history, CONTRIBUTING/SECURITY policy, README for community users | worker | todo |
| M25-2 | Make the GitHub repo public (owner confirms at that moment) | owner | todo |

## M26 — iOS and Android apps (free, no ads — owner decision 2026-10-25; ADR-022)
Decisions (ADR-022): Capacitor 8 wrap of `apps/web` with bundled assets in `apps/mobile`; bundle id / applicationId `org.daisychess.app`; engine in the app = `wasm:lite-single` only (threaded WASM is impossible in Android WebView and not worth a loopback server on iOS); strength via the hub; native Stockfish plugin as the optional last task; GPL code shipped with full offline notices, source tag per release and a custom EULA (accepted residual App Store risk); setup/room links become universal/app links (same URLs), `daisychess://` scheme only for self-hosted hubs; WebView origin `app.daisychess.org` allow-listed on the hub; CI: Android on ubuntu + Gradle Play Publisher, iOS on macOS runners with xcodebuild + altool, tags `mobile-v*`. Owner-only steps are in the M26-0 report and `apps/site/STORE_CHECKLIST.md`.
| ID | Task | Tier | Status |
|---|---|---|---|
| M26-0 | Feasibility study and architecture decision: wrapper, engine/isolation, licensing, deep links, identity, CI (ADR-022); stale `c.referee.at` references corrected; task split below | architect | done (2026-10-26) |
| M26-1 | `apps/mobile` scaffold: `@daisychess/mobile` with Capacitor 8 (exact pins), `capacitor.config.ts` (`appId org.daisychess.app`, `appName DaisyChess`, `webDir ../web/dist-mobile`, `server.hostname app.daisychess.org`, `androidScheme https`), committed `android/` and `ios/App/` (SPM) projects, `.gitignore` for build output; `apps/web` mobile build mode (`vite build --mode mobile`): emits only the `lite-single` engine files, defines the default server URL `wss://play.daisychess.org/ws` (`defaultServerUrl()` reads `VITE_DEFAULT_SERVER_URL` when the origin is not http(s) or the app runs natively — Android serves https://app.daisychess.org), injects the CSP from `csp.config.mjs` as a `<meta http-equiv>`, `src/platform/` seam (`isNativeApp()`, no-op on the web); CI job `mobile` in `ci.yml` (paths filter): Android debug APK on ubuntu, iOS simulator build on `macos-15` (no signing), emulator + simulator smoke that loads the app and asserts `isSecureContext === true`, `crossOriginIsolated === false`, `wasm:lite-single` answers `bestmove` (test hook → logcat / os_log) | senior | done (2026-10-26) |
| | *Acceptance:* `pnpm --filter @daisychess/mobile build` produces both native projects from a clean checkout on Linux (`cap sync`); `dist-mobile` contains no `stockfish-19-lite.*`/`stockfish-19.wasm` and no absolute `https://play.daisychess.org` asset URLs; web unit tests and `scripts/check-csp.mjs` unchanged; the CI smoke logs are attached as artefacts; app size ≤ 15 MB per platform | | |
| M26-2 | Connectivity from the WebView origin: `apps/server/src/ws/origin.ts` accepts `capacitor://…` entries in an explicit `ALLOWED_ORIGINS` list (same-host default unchanged), `.env.example`/deploy README list `https://app.daisychess.org,capacitor://app.daisychess.org`; lichess login in the app through `@capacitor/browser` with redirect URI `daisychess://lichess-callback` (`redirectUri()` per platform, `handleCallback` fed from `appUrlOpen`), token revoke/logout unchanged; explorer, import (lichess, chess.com) and the review store verified from the app origin (CORS) | senior | in review (2026-10-26; redirect URI is `org.daisychess.app://lichess-callback`: lichess refuses `daisychess://`; ADR-022 addendum pending) |
| | *Acceptance:* origin unit tests cover `capacitor:` accept/reject cases (never accepted by the default policy, never with credentials/paths); a hub started with the app origins in `ALLOWED_ORIGINS` passes `deploy/ws-smoke.mjs` unchanged; auth unit tests cover the native redirect URI and the callback via URL; on the Android emulator (CI smoke of M26-1 extended) the app connects to a standalone server on the runner (`10.0.2.2`) and receives `welcome` | | |
| M26-3 | Deep links: `appUrlOpen` → `consumeSetupLink` (fragment grammar extended with `&hub=<wss url>`, validated like `settings.remoteUrl`) and the `#/room/<id>` router; custom scheme `daisychess://setup?token=…&hub=…`; `apps/web/public/.well-known/apple-app-site-association` (fragment-matching components for `setup-token=*` and `/room/*`, Team ID `PM7LTV7M72`) and `assetlinks.json` (rendered by `deploy-web.sh` from `deploy/assetlinks.json.template` only when `PLAY_SIGNING_SHA256` is set); iOS Associated Domains entitlement `applinks:play.daisychess.org`, Android intent filters (autoVerify, exact path `/`, plus the scheme); nginx `play.daisychess.org.conf` AASA location (`default_type application/json`, inherits headers); portal shows the `daisychess://` variant only when `PUBLIC_ORIGIN` is not play.daisychess.org; `docs/SECURITY.md` §2.10 extended | worker | done (2026-10-26; `appUrl.ts` dispatcher, `@capacitor/app` 8.1.2; portal shows the variant as `appLink` of the token response; real-device verification of the links is owner work in M26-9) |
| | *Acceptance:* parser tests (`&hub=` accepted/rejected, legacy tokens unchanged, scheme URL with/without hub, malformed dropped); both well-known files validate with Apple's AASA validator / `adb shell pm get-app-links` once the placeholders are filled (documented); `vite build` copies `.well-known/`; `scripts/check-csp.mjs` passes with the new location | | |
| M26-4 | Native polish and lifecycle: `viewport-fit=cover` + safe-area insets in the layout, status-bar style follows the theme, haptics (move, capture, check, game end; setting to turn off), keep-awake while a game, live game, friend game or drill runs, Android back button = tab/navigation history, engines released on `appStateChange` → background and the shared engine re-created on resume (ADR-015/M19-1 path), settings + token mirrored to `@capacitor/preferences` with localStorage as the read-through cache | worker | done |
| | *Acceptance:* unit tests for the preferences mirror (first start imports, writes mirror, web unchanged) and for the lifecycle release; haptics/keep-awake calls are no-ops in jsdom; axe clean at phone width; no horizontal scroll at 375 px with insets simulated | | |
| M26-5 | Files and sharing: open-with/import of `.pgn` from other apps (iOS exported document type `org.daisychess.pgn` conforming to `public.plain-text`, extension `pgn`, MIME `application/x-chess-pgn`; Android `ACTION_VIEW` intent filters for the PGN MIME types and `.pgn` content URIs) → `appUrlOpen` → read via `@capacitor/filesystem` → the existing multi-game picker; share sheet (`@capacitor/share`, `navigator.share` fallback on the web) for annotated PGN export, setup links and friend links | worker | done (device verification open: iOS Open in / Android Open with and Share, see `apps/mobile/README.md`) |
| | *Acceptance:* unit tests for the URL → import path (file URL, content URI, oversized file rejected with the existing size rule); manual check on a device recorded in the PR (screenshot of the share sheet and of "Open in DaisyChess" from Files/Downloads) | | |
| M26-6 | Licences and About in the app: bundled GPL-3.0 text and `THIRD_PARTY_NOTICES.md` rendered offline (About → Licences), version + git commit + link to the `mobile-v*` tag, `ITSAppUsesNonExemptEncryption=false`; custom EULA text (GPL statement) and App Review notes draft (token for server analysis, offline engine, lichess login is not an app account) in `apps/site/STORE_CHECKLIST.md`; `THIRD_PARTY_NOTICES.md` gains a "Distributed in the mobile apps" section (Capacitor and plugins, MIT) | worker | done |
| | *Acceptance:* the notices screen renders from the repo files at build time (no network); a test asserts every runtime dependency of `apps/mobile` appears in the notices; the notes are reviewed by the orchestrator | | |
| M26-7 | Icons, splash and store assets: `render-brand.mjs` extended for iOS 1024 px (ivory, no alpha), Android adaptive icon layers (foreground/background/monochrome), splash background + mark, Play feature graphic 1024×500; Playwright screenshot script for the store sizes (iPhone 6.9", iPad 13", Android phone/7"/10") in light and dark from the mobile build | worker | review | Done in `apps/mobile`: `scripts/render-assets.mjs` (icons, adaptive layers incl. monochrome, splash light/dark, Play icon and feature graphic), `scripts/store-screenshots.mjs` (5 sizes, light/dark), `store/listing.en.json` (publisher INCEPTUM e.U.), `store/README.md`, `test/store.test.ts` (specs). Owner review of the images and texts pending; nothing uploaded. |
| | *Acceptance:* assets committed under `apps/mobile/resources/` and the native projects; `pnpm --filter @daisychess/mobile screenshots` produces the sets into `apps/mobile/store/`; icon has no transparency on iOS | | |
| M26-8 | Release pipeline `.github/workflows/release-mobile.yml` on `mobile-v*` tags: version check against `apps/mobile/package.json`, build number = `github.run_number`; Android `bundleRelease` signed from `ANDROID_UPLOAD_*` secrets and published to the Play internal track by the Gradle Play Publisher plugin (`PLAY_SERVICE_ACCOUNT_JSON`); iOS archive + export (`app-store-connect`, manual signing with `IOS_DIST_CERT_*`, `IOS_PROVISIONING_PROFILE_B64`) and `xcrun altool --upload-app` with `ASC_*` → TestFlight; actions pinned by SHA; `deploy/README.md` section "Mobile release" (secrets, rotation, how to tag); `scripts/mobile/new-upload-keystore.sh` for the owner | senior | review (2026-10-26; Play publishing by `apps/mobile/scripts/play-publish.mjs` (Publisher API; only when the variable `PLAY_PUBLISH_ENABLED` is `true`, after the first manual upload; the AAB is always kept as artifact) instead of the Gradle Play Publisher plugin; iOS App Store profile created/reused through the ASC API (`asc-profile.mjs`) with manual signing, `IOS_PROVISIONING_PROFILE_B64` only an optional override; owner helpers `scripts/mobile/{new-upload-keystore,set-ios-secrets,build-signed-aab}.sh`; signed store runs unverified until the owner sets the secrets; ADR-022 addendum pending) |
| | *Acceptance:* workflow passes on a tag with the secrets present (owner runs it once after M26-9); without secrets the jobs fail fast with a clear message before building; no secret is echoed (log review in the PR); `workflow_dispatch` builds without upload for testing | | |
| M26-9 | Store records and signing (owner): App Store Connect app + API key + provisioning profile, Play Console app + service-account access + upload keystore, Team ID and Play signing SHA-256 into the repo variables / placeholders of M26-3, first TestFlight + internal-track upload, Google closed test (≥ 12 testers / 14 days if the account requires it), review submissions | owner | todo |
| M26-10 | Native Stockfish plugin (optional, after v1 feedback): pinned, sha256-verified Stockfish source built by NDK (arm64-v8a, x86_64 for the emulator) and Xcode (arm64 device + simulator), in-process UCI over the Capacitor bridge, `NativeEngineClient implements EngineClient`, registry entry `native:stockfish` (multi-thread, hash per device memory), ADR addendum on memory/thermal limits; GPL exposure unchanged (ADR-022 §3) | senior | todo (decide after launch) |
| | *Acceptance:* `EngineClient` contract tests pass against the native client on the emulator/simulator; review of a 40-move game is ≥ 3x faster than `lite-single` on the CI emulator; engine stops within 200 ms on `stop`; no engine thread survives app background > 30 s | | |

## M27 — daisychess.org (decided 2026-10-25: domain daisychess.org; community site on the apex, web app on play.daisychess.org)
| ID | Task | Tier | Status |
|---|---|---|---|
| M27-1 | Community site `apps/site` on daisychess.org (+ www → apex): description, all features, community nodes, open source, app-store pages (privacy policy, terms, support, imprint, data deletion, accessibility), gsap + three + Lenis with a 3D pawn, strict CSP, reduced-motion fallback; nginx vhost + deploy script | senior | done (`apps/site`) |
| M27-2 | Move the web app + portal to play.daisychess.org: origins, CSP, lichess OAuth client ids, setup links, hub URL `wss://hub.daisychess.org/link` (alias on play), nginx vhost, c.referee.at → 301 with one-time localStorage migration | senior | done |
| M27-3 | Production cut-over (nginx, certs, env, ROLE=hub = M24-7) | orchestrator | done (2026-10-25 22:40) |
| M27-4 | Remove the legacy c.referee.at machinery (retired immediately by owner decision, see ADR-021 addendum): moved page, `#migrate=` import, legacy CSP/vhost/deploy script, origin defaults and docs; the sunset item is dropped | worker | done (2026-10-26) |

## M28 — Maintenance after going public (2026-10-25)
| ID | Task | Tier | Status |
|---|---|---|---|
| M28-1 | Upgrade Vitest 3 → ≥ 4.1.12 in all packages (dev-only advisories: vitest/@vitest/mocker path traversal + mock injection, tinypool prototype pollution); nothing shipped is affected | worker | todo (after M27, lockfile) |
| M28-2 | Dependabot version updates config (`.github/dependabot.yml`, weekly, grouped), GitHub Actions minutes now free (public) | worker | todo |
| M28-3 | Raise `engines.node` to `>=22.13` in all package.json files (CI already on 22/24) | worker | todo |
| M28-4 | Operator account deletion: portal API `DELETE /api/portal/me` (revokes nodes/tokens, closes links/connections, deletes operator row, sessions, usage rows) + portal UI; PRIVACY.md already promises it | senior | todo (after M27-2) |
| M28-5 | Hub store backup timer (daily `.backup`, 7 copies) as promised in PRIVACY.md | worker | todo |
| M28-6 | Application logs expire after 7 days: journald namespace `daisychess` (`LogNamespace=` + `deploy/journald@daisychess.conf`), host-wide journald untouched | worker | done (host activation by orchestrator) |

## M29 — UI polish (2026-10-26)
| ID | Task | Tier | Status |
|---|---|---|---|
| M29-1 | "Daisy" look: the light theme is replaced by the community-site palette (cream, white cards, yellow accent, pill buttons, self-hosted Inter); dark theme keeps its look but uses the yellow accent. New tokens `--accent-ink`, `--accent-soft`, `--border-strong`, `--focus`, `--radius-pill` in `packages/ui-theme` | worker | done |
| M29-2 | Theme toggle on the community site (apps/site): moon/sun button in the header, system default, choice in localStorage `daisychess.theme`, applied before first paint by external `/theme-init.js` (CSP unchanged), hero pawn follows live | worker | done |
| M29-3 | Online import fixes: chess.com walks monthly archives backwards (max 12 sequential requests per call) until the page is full instead of reading only the last two; lichess lists with `pgnInJson=true` in one ndjson stream (no per-game export), requests to a site run one at a time, 429 honours Retry-After (min. 1 minute for lichess, fails fast meanwhile) and a CORS-less 429 (fetch TypeError right after a successful call) reads "rate limit – try again in a minute" instead of "check your connection"; "Load more" in the list (lichess `until`, chess.com archive cursor) | worker | done |
| M29-4 | Live tab for personal-token users: not logged in offers OAuth login and an inline token paste (prefilled create link); token without `board:play` explains the missing scope with create link and replace field instead of an OAuth button; OAuth without scope keeps "Log in again"; Board API rule shown at the seek controls. Scope handling for `source==='token'` verified (no bug; cause was a token lacking `board:play`) | worker | done |
| M29-5 | Lichess ratings in the Live tab: own side of a live game now carries its rating (`LiveGame.me`; before, the own bar only said "You"), `provisional` ("?") and `ratingDiff` (shown only when lichess sends it in gameFull; the stream normally does not) are parsed, title shown before the name, AI as "Stockfish / level N"; Live overview lists bullet/blitz/rapid/classical/correspondence from `/api/account` `perfs` (rating, provisional, games; one request, 5 min cache, `live/ratings.ts`) | worker | done |
