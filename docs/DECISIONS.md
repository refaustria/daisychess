# Architecture Decision Records

## ADR-001 — Ports on the production host
**Date:** 2026-10-23 · **Status:** accepted

**Context.** The README suggests the engine server on 8080 and the Vite dev server on 5173. On the production host (c.referee.at) 8080 is used by an unrelated service and 5173 by another dev server.

**Decision.** The ChessLab server listens on `127.0.0.1:8580` by default (`PORT` env var). The Vite dev server uses `5180`. nginx terminates TLS and proxies `/ws` and `/health` to 8580.

**Consequences.** README dev section documents the new ports. Nothing is exposed directly; only nginx listens publicly.

## ADR-002 — Hosting model for c.referee.at
**Date:** 2026-10-23 · **Status:** accepted

**Context.** We need early, visible results and later server-mode analysis on the same machine. The host already runs nginx with certbot-managed vhosts.

**Decision.** Static frontend build is served by nginx from `/var/www/c.referee.at` with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (needed for multi-threaded WASM). TLS via Let's Encrypt (certbot nginx plugin). The engine server runs as a systemd service bound to localhost; nginx proxies `/ws`. Deployment config lives in `deploy/` in the repo. Docker compose (M6) remains for other hosts.

**Consequences.** All third-party resources must be same-origin or CORP-enabled (COEP). Deploy is a script, not CI (CI only tests).

## ADR-003 — Native Stockfish build target on this host
**Date:** 2026-10-23 · **Status:** accepted

**Context.** The VM CPU (QEMU virtual CPU) exposes SSE4.1/SSE4.2/POPCNT but **no AVX2/BMI2**.

**Decision.** `scripts/fetch-engines.sh` must detect CPU flags and select the `x86-64-sse41-popcnt` Stockfish build when AVX2 is absent (AVX2/BMI2 builds otherwise). 16 cores / 30 GB RAM are available; engine pool limits will be sized accordingly in M3.

**Consequences.** Lower NPS than an AVX2 build; still far stronger than browser WASM.

## ADR-004 — Node version
**Date:** 2026-10-23 · **Status:** accepted

**Context.** README says Node 20; host has Node 24.

**Decision.** Target `node >= 20` (`engines` field), CI matrix on Node 20 and 22. Host runs 24.

**Update 2026-10-23.** Stockfish 19 only ships "universal" Linux tarballs that select the instruction set at runtime; on this host the binary reports `x86-64-sse41-popcnt`. `scripts/fetch-engines.sh` prefers per-CPU assets when a release lists them (sf_18 and older) and falls back to the universal asset. Measured ~420 kNPS single-threaded at depth 12.

## ADR-005 — Browser engine delivery (Stockfish WASM)
**Date:** 2026-10-23 · **Status:** accepted

**Context.** README §2.1 asks for the `stockfish` npm builds: `lite-single` by default and the multi-threaded build when COOP/COEP headers are present. `stockfish@19.0.1` ships classic, non-module Emscripten worker scripts that locate their `.wasm` by their own URL and spawn pthread workers from `self.location.href`; bundling or renaming them breaks that. Loading from a CDN is ruled out by COEP `require-corp` (ADR-002).

**Decision.** Depend on `stockfish@19.0.1` (pinned exactly). A Vite plugin (`apps/web/vite-plugin-stockfish.ts`) copies only `stockfish-19-lite{,-single}.{js,wasm}` unchanged to `assets/engine/stockfish-<version>/` and serves the same path in dev with COOP/COEP/CORP headers. The version in the directory name replaces content hashing, so the nginx `/assets/` rule (immutable cache, headers) covers the files unchanged. `WasmEngineClient` starts a classic `Worker`, uses `lite` with `min(cores-1, 4)` threads when `crossOriginIsolated`, otherwise `lite-single`. All scores leave the client from White's point of view (helpers in `engine-core/pov.ts`, shared with the future `RemoteEngineClient`). `analyze()` returns an `AnalysisHandle` (AsyncIterable plus `bestMove` promise) that still satisfies the `Engine` interface. The ~99 MB full builds are not shipped (deferred opt-in).

**Consequences.** All engine files are same-origin and work under COEP. Upgrading Stockfish bumps the pinned version, which changes the URL and busts the cache. `pnpm install` downloads the whole ~155 MB package in CI as well. Measured in headless Chromium on this VM: ~2.0 MNPS with 4 threads (`lite`), ~0.4 MNPS single-threaded.

## ADR-006 — Browser ⇄ server WebSocket protocol
**Date:** 2026-10-23 · **Status:** accepted

**Context.** Server mode (M3) streams native-engine analysis to the browser. The server (M3-2) and `RemoteEngineClient` (M3-4) are built by different agents and must agree on one contract up front. The browser side already consumes the `Engine`/`AnalysisHandle` shape through `UciSession` (one search per engine, a new `analyze` replaces the running one, scores converted to White's point of view in `engine-core/pov.ts`). M5 needs several engines per client in parallel. The server must protect a shared machine (16 cores, ADR-003) against expensive or malicious requests, and both sides use Zod v4 already (`apps/server`).

**Decision.** The protocol is defined once, as Zod schemas with inferred types, in `packages/engine-core/src/protocol.ts` (`zod` becomes a dependency of `engine-core`; no DOM/Node APIs). JSON text frames, one message per frame, discriminated by `type`.

- *Messages.* Client → server: `hello` (`protocolVersion`, optional `client {name, version}`), `analyze` (`sessionId`, `searchId`, `engine`, `fen`, optional `multipv`, `depth`, `movetime`, `threads`, `hash`), `stop {sessionId}`, `release {sessionId}`, `ping {t?}`. Server → client: `welcome` (`protocolVersion`, `serverVersion`, `limits`, `engines[] {id, name, enabled, defaults {threads, hash}}`), `info {sessionId, searchId, info: EngineInfo}`, `bestmove {sessionId, searchId, bestMove: BestMove | null, reason: completed | stopped | limit}`, `error {code, message, sessionId?, searchId?}`, `pong {t?}`. There is no `setOptions` message: the only client-settable UCI options are `Threads` and `Hash`, carried on every `analyze` (typed fields, so arbitrary UCI options such as `Debug Log File` or `EvalFile` cannot reach a native process), which also makes `analyze` self-contained and sessions recreatable.
- *Session model.* `sessionId` is **client-chosen** (`[A-Za-z0-9_-]{1,64}`, scoped to the connection) so that `RemoteEngineClient.analyze()` can return an `AnalysisHandle` synchronously and `stop` needs no round trip. A session leases one engine instance; it is created implicitly by the first `analyze`, freed by `release`, by a server idle timeout (no running search) or when the socket closes (all sessions of the connection are stopped and released; nothing survives a reconnect). `searchId` (client-chosen positive integer, unique per session; a counter) identifies one `go`; it is echoed on `info`, `bestmove` and search-level `error` so the client can attribute every message even when it has already queued the next search. A new `analyze` on a session with a running search stops it (`bestmove … reason: stopped` is delivered before any `info` of the new search), mirroring `UciSession`. Every accepted search ends with exactly one terminal message: `bestmove`, or an `error` carrying its `searchId`. `error` with `sessionId` only is session-level (`engine_crashed` releases the session); `error` without `sessionId` is connection-level. `stop` on an idle session is a no-op; `release` is idempotent.
- *Point of view.* The server relays **raw UCI, side-to-move scores**; it does not convert. The client already knows the FEN of each search and applies `infoToWhitePov(info, sideToMove(fen))`, exactly as `UciSession` does for WASM, so there is a single, tested conversion path and the server stays a transparent UCI relay (`info.info` is exactly `EngineInfo`, enforced by a compile-time assignability check).
- *Handshake and versioning.* The first client message must be `hello`; the server answers `welcome` or `error: protocol_mismatch` and closes (WebSocket close code 1008). Any other message before `hello` → `handshake_required`. `PROTOCOL_VERSION = 1` is bumped on incompatible changes; additive optional fields do not require a bump because unknown fields are **stripped**, not rejected (unknown `type` is rejected).
- *Limits.* Two layers: hard ceilings baked into the schemas (`PROTOCOL_BOUNDS`: depth 1–99, movetime 100–600 000 ms, multipv 1–10, threads 1–64, hash 1–16 384 MB, FEN ≤ 100 chars, pv ≤ 300 moves, frame ≤ 16 KiB → `invalid_message`), and per-connection `Limits` the server announces in `welcome.limits` (`DEFAULT_LIMITS`: depth 30, multipv 5, threads 4, hash 512 MB, movetime 600 s, 2 sessions per connection; overridable by `MAX_*` env vars) checked with the shared `checkAnalyzeLimits()` → `limit_exceeded`. Global capacity (`MAX_SESSIONS`, `maxInstances` per engine) is server-side → `no_capacity`. FENs are validated syntactically (`isValidFen`: 8 ranks of 8 squares, exactly one king per side, side, castling incl. Chess960 letters, en passant, optional counters) before they reach a native process; newlines can therefore not be injected into UCI commands.
- *Error codes.* `invalid_message`, `protocol_mismatch`, `handshake_required`, `unknown_engine`, `limit_exceeded`, `no_capacity`, `session_not_found`, `engine_crashed`, `rate_limited`, `internal_error`.
- *Parsing.* `parseClientMessage()`/`parseServerMessage()` accept JSON text or a parsed value and return `{ ok: true, message } | { ok: false, error }` with `type: path: message` diagnostics; both sides validate outgoing as well as incoming messages in tests.

**Consequences.** M3-2 and M3-4 can be implemented independently against `@chesslab/engine-core`; the server sets `ws` `maxPayload` to `MAX_MESSAGE_BYTES`, maps `analyze.threads/hash` to `setoption`, and must emit the previous search's `bestmove` before the next search's `info`. `RemoteEngineClient` keeps a map `(sessionId, searchId) → handle`, converts POV itself and can fail fast using `welcome.limits`. `zod` ships to the browser bundle (≈ 15 kB gzipped). Changing message shapes incompatibly means bumping `PROTOCOL_VERSION` and this ADR. Engine-specific UCI options (Elo, skill level, variants) are deliberately not exposed; adding them later is an additive change (`analyze.options` with a server-side allow-list).


## ADR-007 — Engine server policies (apps/server)
**Date:** 2026-10-23 · **Status:** accepted

**Context.** ADR-006 fixes the wire protocol; the server (M3-2) still had to decide resource and abuse policies for a shared 16-core host.

**Decision.**
- Every search has a wall-clock cap: `MAX_MOVETIME_MS` (600 s default), or `movetime + 2 s`. Hitting it ends the search with `bestmove … reason: 'limit'`.
- Sessions without a running search give their engine back after `SESSION_IDLE_MS` (10 min) and are recreated transparently on the next `analyze`. Idle engine processes beyond one per engine are killed after `ENGINE_IDLE_MS` (5 min).
- Backpressure: `info` messages are dropped while a socket buffers more than 1 MiB; terminal (`bestmove`) and `error` messages are never dropped.
- Rate limits: more than 20 `analyze`/s per connection → `rate_limited`; more than 100 messages/s of any type → `rate_limited` and close 1008. Handshake timeout 10 s → close 1008. Heartbeat ping every 30 s.
- `invalid_message` for a malformed `analyze` carries `sessionId`/`searchId` when they parse, so clients can settle the handle.
- Only `Threads`, `Hash`, `MultiPV` (and `UCI_Chess960`, currently unused) can ever reach a native process; option values are cached so an unchanged `Hash` is not re-sent.
- All outgoing messages are validated against `ServerMessageSchema` (always on; invalid ones are logged and dropped).
- Enabled engines whose binary is missing are listed as disabled.

**Consequences.** Defaults (`MAX_SESSIONS=4`, `MAX_THREADS=4`, `maxInstances=3`) use at most 12 of 16 cores. Per-IP limit: nginx `limit_conn chesslab_ws 10` on `/ws` (429 above). Open: no Origin check yet (M6-3 security review).

## ADR-008 — Security policies for the public engine server (M6-3)
**Date:** 2026-10-23 · **Status:** accepted

**Context.** The engine server is a public, unauthenticated WebSocket in front of native processes (ADR-006/007). The M6-3 review (`docs/SECURITY.md`) found three things that needed a policy rather than a patch: browsers attach the page's `Origin` to every WebSocket handshake and apply no CORS to it, so any website could open `/ws` from a visitor's browser (cross-site WebSocket hijacking) and spend that visitor's per-IP quota; Stockfish 19 strictly validates `position fen` and terminates the process (`exit(1)`, no `bestmove`) on positions that pass the syntactic `isValidFen` — adjacent kings, a king capturable by the side to move, pawns on the first/eighth rank, more than 8 pawns or more promoted pieces than missing pawns, more than 32 pieces, an en-passant square on the wrong rank — which made every such `analyze` a cheap engine respawn (~100 MB binary + NNUE init); and `scripts/fetch-engines.sh` verified the Stockfish download only when `jq` happened to be installed (it is not, on the production host).

**Decision.**
- *Origin policy* (`apps/server/src/ws/origin.ts`, env `ALLOWED_ORIGINS`). Enforced at upgrade time, before `ws` sees the socket; a rejected handshake gets HTTP 403 and a `warn` log line. Requests without an `Origin` header are accepted (only browsers send it; a non-browser client can forge any value, so rejecting its absence would break tooling without adding security). `ALLOWED_ORIGINS` is a comma-separated list of `scheme://host[:port]` origins (normalised, exact match) or `*` (check disabled); a malformed entry fails startup. Unset, the origin's host name must equal the request's `Host` name (ports ignored because the proxy forwards `Host` without one), or both must be loopback (Vite on :5180 → server on :8580). Production sets `ALLOWED_ORIGINS=https://c.referee.at` in the unit; Docker compose relies on the same-host default so any `WEB_PORT` works.
- *FEN validation mirrors Stockfish.* `isValidFen` (engine-core, shared by both sides) now rejects exactly what `Position::set` rejects, so a client-supplied position can never terminate an engine; it still accepts what Stockfish merely sanitises (bogus castling rights, an en-passant square without a capturable pawn). This is stricter input validation, not a wire change: `PROTOCOL_VERSION` stays 1.
- *Verified engine downloads.* `fetch-engines.sh` fails closed: the asset's sha256 must match the digest GitHub publishes for the release (parsed with `jq` or `node`) and, when set, `STOCKFISH_SHA256`; downloads only from `github.com`/`objects.githubusercontent.com`; `--no-verify` downgrades a missing digest/tool to a warning. The Docker image pins `STOCKFISH_VERSION=sf_19` and its digest.
- *Health split.* Public `/health` returns `{status, version}`; pool statistics (busy/idle engines, sessions, connections) moved to `/health/detail`, which nginx does not proxy.
- *Host hardening* applied live: systemd `CapabilityBoundingSet=`, `SystemCallFilter=@system-service` (+`SystemCallErrorNumber=EPERM`, `SystemCallArchitectures=native`), `IPAddressDeny=any`/`IPAddressAllow=localhost` (no egress), `ProtectProc=invisible`, `ProtectClock/Hostname/KernelLogs`, `RestrictNamespaces/Realtime`, `RemoveIPC`, `UMask=0077`; nginx `limit_req` 5 handshakes/s (burst 20) per IP on `/ws` next to the existing `limit_conn 10`, and `Content-Security-Policy: frame-ancestors 'none'`; Docker `server` runs read-only with `cap_drop: ALL` and `no-new-privileges`.

**Consequences.** Hosting the web app on a different origin than the server now requires `ALLOWED_ORIGINS`. `deploy/nginx/c.referee.at.conf` (committed empty by mistake in 47cffbf) is restored and is again the source for the live vhost. `ProcSubset=pid` is deliberately not set (Stockfish and libuv read `/proc/cpuinfo`, `/proc/stat`). Residual risks and the prioritised backlog (per-IP session cap, full CSP, base-image digests, respawn backoff) are in `docs/SECURITY.md`.

**Addendum (2026-10-23): per-IP session cap and respawn backoff** (the two P1 items of `docs/SECURITY.md` §4).
- *Per-IP session cap.* `MAX_SESSIONS_PER_IP` (default `min(2, MAX_SESSIONS)`; larger than `MAX_SESSIONS` fails startup) limits engine sessions that hold or are acquiring a lease, per client address and across all of its connections; one `IpSessionLedger` per WebSocket server. Reserved synchronously right before `pool.acquire` and released wherever the lease is dropped, so idle sessions without a lease do not count. Refusal reuses `no_capacity` (message "too many sessions from your address") — no protocol change, `PROTOCOL_VERSION` stays 1. Client address: `X-Real-IP` only if the TCP peer is loopback or listed in `TRUSTED_PROXIES` (`*` = any peer, used by Docker compose where nginx is another container and 8580 is not published), else the peer address; normalised (IPv4-mapped IPv6 unwrapped, zones stripped).
- *Respawn backoff.* Per engine, the pool counts consecutive crashes (unexpected exits, failed starts; exits the pool caused are not crashes). After the n-th it refuses to spawn that engine for `min(500 ms · 2^(n−1), 30 s)` with ±20 % jitter; such `acquire`s return `no_capacity` immediately instead of waiting (idle instances are still leased). Reset when an instance stays up `ENGINE_CRASH_RESET_MS` (60 s) or a search on it ends with `bestmove` (`pool.reportHealthy`); a running backoff is not shortened. From `ENGINE_MAX_CONSECUTIVE_CRASHES` (10) on, the engine is `degraded` and the delay stays at 30 s. Visible only in `/health/detail` (`crashes`, `backoffUntil`, `degraded`); `welcome.engines[].enabled` keeps the configured value.
- *Consequence.* A client whose search crashed an engine sees `no_capacity` for ~0.5 s if it retries at once (the web client shows "Server busy, try again"). `/health/detail` gains `clientAddresses`.

## ADR-009 — Multi-engine analysis store
**Date:** 2026-10-23 · **Status:** accepted (shared settings superseded by ADR-010)

**Context.** M5-1 lets users run several engines (browser WASM builds, server engines) on the same position side by side. The single-engine store (`settings.backend`) could not express that.

**Decision.** Engines are identified by registry keys (`wasm:lite`, `wasm:lite-single`, `remote:<engineId>`; `apps/web/src/engine/registry.ts`). The analysis store keeps shared `fen`/`terminal`/`settings` (depth, MultiPV, threads apply to all engines) and per-engine state in `instances[key]`, with one `AnalysisController` per enabled key. `enabledEngines` is persisted; a master `enabled` switch stops/resumes all. Server engines are discovered by a probe (`hello`/`welcome`, cached 60 s). Resource guard: at most one of each WASM build and two server engines. `selectPrimary` (first enabled engine) feeds the eval bar and the best-move arrow. Old persisted settings (`backend: 'remote'`) migrate to `['remote:stockfish']`.

**Consequences.** Settings are shared across engines (per-engine settings would be a product decision). The probe opens a short extra WebSocket connection when the picker opens. The engine factory signature in `startAnalysisController` is `(spec, settings)`.

## ADR-010 — Per-engine settings, server access token, full-strength browser build
**Date:** 2026-10-23 · **Status:** accepted

**Context.** Product decisions after M5/M6 (PLAN M9-1..M9-4): engines compared side by side need their own depth/MultiPV/threads (a fast browser engine and a deep server engine rarely want the same limits); the public engine server should be closable to a known group without accounts; users with fast machines want the full-strength Stockfish network in the browser; the AnalysisPanel unit tests depended on the CI machine's core count.

**Decision.**
- *Per-engine settings* (`apps/web/src/store/analysisStore.ts`). `settings` stays the global default (plus the global `remoteUrl`). New `engineSettings: Record<EngineKey, Partial<{depth, multipv, threads}>>` holds overrides per registry key, persisted in `chesslab.analysis` (also for engines that are currently disabled; omitted when empty, so the old shape still loads and is still written when nobody overrides anything). Each controller runs with `effectiveSettings(state, key)` = defaults merged with the override; MultiPV line merging uses the engine's own value. Actions: `setEngineSettings(key, patch)` (`null` removes a field), `applySettingsToAll(key)` (the engine's effective settings become the defaults, all overrides are cleared). UI: with two or more engines the Depth/Lines/Threads selects edit the selected tab's engine, labelled "Settings for <engine>", with an "Apply to all" link; with one engine they edit the defaults (and drop that engine's override of the changed field), so the single-engine panel is unchanged.
- *Server access token* (protocol, additive). `hello` gains optional `token` (string, ≤ 256 = `MAX_TOKEN_LENGTH`); new error code `unauthorized`. `PROTOCOL_VERSION` stays 1: old clients against a public server and new clients against an old server both keep working (an old server ignores the unknown field). Server env `ACCESS_TOKEN` (optional; empty = public). If set, `hello.token` is compared in constant time (SHA-256 of both sides + `timingSafeEqual`); missing/wrong → `error unauthorized` and close 1008, before `welcome` (so no engine list or limits leak). The token is never logged (only `tokenSent: true|false`). It travels only in `hello`, not in the URL or `Sec-WebSocket-Protocol`, so it does not appear in nginx access logs. Web: Settings tab "Server access token" (password input with show/hide, explicit Save), stored as `serverToken` in `chesslab.settings`; `RemoteEngineClient({ token })`; the store's probe and engine factories pass it; saving a new token drops the probe cache and reconnects all server engines. `unauthorized` is shown as "Access token required or wrong" with a pointer to the Settings tab (engine status, panel, picker). `deploy/ws-smoke.mjs` and `deploy/ws-limits-check.mjs` read `CHESSLAB_TOKEN`.
- *Full-strength WASM build* (opt-in). `vite-plugin-stockfish.ts` also ships `stockfish-19.js` + `stockfish-19.wasm` (multi-threaded, full NNUE embedded, 99,076,105 bytes, ~79 MB gzip) next to the lite builds; `__STOCKFISH_ENGINE__.sizes` carries download sizes. `WasmBuild = 'lite' | 'lite-single' | 'full'`; registry key `wasm:full`, labelled "Stockfish 19 (browser, maximum strength, ~99 MB download)", badge "browser max", available only on cross-origin isolated pages, `capabilities().build = stockfish-19.0.1-full`. `wasm:lite` and `wasm:full` are mutually exclusive (`displacedBy`): enabling one replaces the other in its tab position with a hint, so there is still at most one multi-threaded WASM engine. Before the first download the picker asks for confirmation (remembered in `localStorage` `chesslab.fullBuildConfirmed`). The file is fetched only when the engine is enabled; it is versioned under `assets/engine/stockfish-<version>/` like the others.
- *Deterministic UI tests.* The page capabilities (`crossOriginIsolated`, `hardwareConcurrency`) live in the analysis store as `env` (initialised from `currentEnv()`); the panel and picker read them from there instead of `navigator`, and tests set them explicitly. Picker labels are unique on every machine: "browser, multi-thread, N threads" / "browser, single-thread" / "browser, maximum strength, ~N MB download".

**Consequences.** Enabling the token on production locks out the deployed web build until users enter the token (old builds send none). The token is a shared secret in each user's `localStorage` — a gate against casual/anonymous use, not per-user authentication; rotating it means editing `.env.production`, restarting the service and handing out the new value. `dist/` grows by ~99 MB (rsync deploys transfer it once per Stockfish version). Server engines without overrides follow later changes of the defaults; an override survives disabling and re-enabling its engine.
