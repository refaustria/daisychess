# ChessLab security review (M6-3)

**Date:** 2026-10-23 · **Scope:** `apps/server`, `packages/engine-core/src/protocol.ts`, `deploy/`, `docker/`, `scripts/fetch-engines.sh`, the live host `c.referee.at` (nginx + `chesslab-server.service`) and the client-side isolation headers. Policies decided here are recorded in `docs/DECISIONS.md` ADR-008.

## 1. Threat model

| Asset | Threat | Who |
|---|---|---|
| Native Stockfish processes behind a public, unauthenticated WebSocket | Command/UCI injection; crashing the engine; running the engine on behalf of someone else's browser | Anyone on the internet; any website a user visits |
| The shared 16-core host (ADR-003) | CPU/memory exhaustion, process storms, connection floods, slow clients | Anyone on the internet |
| Operator information | Error details, paths, capacity/activity data, IP/FEN logging | Anyone (public endpoints), log readers |
| Supply chain | Tampered engine binary, npm packages, base images | Network attacker, upstream compromise |
| The web app in the browser | Clickjacking, cross-origin data leaks, XSS | Third-party sites |

No user accounts exist (v1 non-goal), so there is no authentication surface and no per-user data on the server; the browser holds only UI settings in `localStorage`.

## 2. Findings and fixes

Severity: **High** = exploitable from the internet with real impact, **Medium** = meaningful but bounded, **Low** = hygiene.

### 2.1 Engine-terminating FENs pass validation — High, fixed

`isValidFen` (`packages/engine-core/src/protocol.ts`) checked syntax and king count only. Stockfish 19's `Position::set` validates more and, on failure, the UCI loop calls `terminate_on_critical_error` → `exit(1)` without a `bestmove` (verified against `engines/stockfish/stockfish`; `src/position.cpp` lines 167–445 and `src/uci.cpp` line 523 of tag `sf_19`). Positions that killed the process:

| FEN (schema-valid before the fix) | Reason |
|---|---|
| `kK6/8/8/8/8/8/8/8 w - - 0 1` | adjacent kings (king capturable) |
| `k6R/8/8/8/8/8/8/K7 w - - 0 1` | side not to move in check |
| `PPPPPPPP/pppppppp/8/8/8/8/8/Kk6 w - - 0 1` | pawns on rank 8 |
| `k7/pppppppp/7p/8/8/8/8/K7 w - - 0 1` | 9 pawns |
| `k7/8/8/8/8/1QQQQ3/1QQQQQ1Q/K7 w - - 0 1` | 10 queens = 9 promotions > 8 missing pawns |
| `qqqqqqqk/…/QQQQQQQK w - - 0 1` | > 32 pieces |
| `k7/8/8/8/8/8/8/K7 w - e3 0 1`, `… b - e6 0 1` | en-passant square on the wrong rank for the side to move |

The server handled the crash correctly (`engine_crashed`, lease dropped, process reaped, respawn on demand), but each crash cost a fresh Stockfish start (103 MB binary, NNUE init, hash allocation) for the price of one 150-byte frame — 20/s per connection, 10 connections per IP. *Fix:* `isValidFen` now mirrors Stockfish's rules (`parseBoard` + `isAttacked`), shared by server and client, with every rule pinned by a test whose FENs were run against the real binary (`protocol.test.ts` "rejects positions that make Stockfish terminate"). *Verify:* `node -e` sending `kK6/8/8/8/8/8/8/8 w - - 0 1` to `wss://c.referee.at/ws` now gets `invalid_message`; `/health/detail` shows the engine still idle.

### 2.2 No Origin check (cross-site WebSocket hijacking) — High, fixed

`apps/server/src/ws/server.ts` accepted any upgrade on `/ws`. Browsers send the page's `Origin` and ignore CORS for WebSockets, so `https://evil.example` could script a visitor's browser into opening sockets to `c.referee.at/ws`, consuming the visitor's per-IP quota and the server's engine capacity, and read the analysis back. *Fix:* `ws/origin.ts` (`ALLOWED_ORIGINS`, ADR-008) enforced before `handleUpgrade` → `403 Forbidden`. Production: `ALLOWED_ORIGINS=https://c.referee.at` in the unit. Unit tests (`origin.test.ts`, 8 cases incl. `null` origin, credentials, sub-domain look-alikes, loopback) and integration tests (`ws.test.ts` "Origin check"). *Verify (live):* `curl -H 'Origin: https://evil.example' …/ws` → 403; `Origin: https://c.referee.at` → 101; `Origin: http://c.referee.at` (wrong scheme) → 403.

### 2.3 UCI / command injection — no finding

Every path from client input to engine stdin was traced: `analyze.fen` → `FenSchema` (regex, ≤ 100 chars, no whitespace other than the five separators) → `UciProcess.position()` → `send()` which rejects `\r`/`\n`; `threads`/`hash`/`multipv` are integers bounded by the schema and `Limits`, formatted with `String(number)`; `depth`/`movetime` are integers; option names come from the `ALLOWED_UCI_OPTIONS` allow-list and `setOptions` throws on anything else; the engine `id` only selects a registry entry. Processes are spawned with `shell: false`; the binary path comes from `engines.json`, never from the client. The server validates its own outgoing frames (`ServerMessageSchema`), so a hostile engine build cannot push off-contract data to browsers. Registry options other than `Threads`/`Hash` are ignored with a warning (`app.ts`).

### 2.4 Resource exhaustion — Medium, partly open

In place: `maxPayload` 16 KiB and `perMessageDeflate: false` (no decompression bombs); 100 msg/s → close 1008; 20 `analyze`/s; handshake (`hello`) timeout 10 s; heartbeat 30 s; wall-clock cap on every search (`MAX_MOVETIME_MS` 600 s, or `movetime + 2 s`); `info` dropped under 1 MiB backpressure, terminals never; `MAX_SESSIONS=4` global, 2 per connection, `maxInstances=3`; `MemoryMax=12G`, `TasksMax=512`, `CPUWeight=80`; idle reaping; `KillMode=control-group` and `tini` so no orphan engines; the Node HTTP server's own header timeouts (60 s) and nginx's `client_header_timeout` cover slowloris on the HTTP upgrade. Per-connection maps (`sessions`, `retiring`, rate-limit arrays) are bounded by those limits; `retiring` entries are deleted when their chain settles. Memory bound: 4 × (512 MB hash + ~150 MB process) ≈ 2.7 GB < 12 GB.

Added: nginx `limit_req` 5 handshakes/s per IP (burst 20) on `/ws` next to `limit_conn 10` (live test: 40 parallel handshakes → mix of 403/429, none reached Node beyond the burst).

Added (follow-up, same day): **per-IP session cap** — one IP could hold 10 connections × 2 sessions = 20 session requests against a global cap of 4, i.e. monopolise the service. Now `MAX_SESSIONS_PER_IP` (default 2, ≤ `MAX_SESSIONS`) counts engine sessions per client address over all of its connections (`ws/clientIp.ts`, `IpSessionLedger`); the slot is reserved synchronously before the pool acquire (no race between two sockets of one address) and returned when the lease is dropped (release, idle release, engine switch, crash, disconnect). Over the cap → `no_capacity` "too many sessions from your address" (no new error code). The address is `X-Real-IP` only when the TCP peer is loopback (nginx) or in `TRUSTED_PROXIES`, otherwise the peer itself, so the header cannot be spoofed by direct clients; IPv4-mapped IPv6 is unwrapped. Two addresses suffice to fill the global cap of 4 — the cap stops a single client, not a distributed one. **Respawn backoff** — crashed engines were respawned on the next request without delay. Now the pool counts consecutive crashes per engine (unexpected exits and failed starts; not exits caused by shutdown or by killing an unhealthy instance) and, after the n-th, spawns no new instance of that engine for `min(500 ms · 2^(n−1), 30 s)` ± 20 %; requests that would need a new process get `no_capacity` at once (idle instances are still served). The counter resets when an instance stays up `ENGINE_CRASH_RESET_MS` (60 s) or completes a search; after `ENGINE_MAX_CONSECUTIVE_CRASHES` (10) the engine is `degraded` (`/health/detail`: `crashes`, `backoffUntil`, `degraded`; `error` log line) and retried every 30 s. Tests: `clientIp.test.ts`, `ws.test.ts` "per-IP session cap", `EnginePool.test.ts` "respawn backoff".

Open (see §4): a client can force a 512 MB hash re-allocation per `analyze` by alternating `hash` values (bounded by the analyze rate; equivalent to burning its own CPU share, not an amplifier). A client that alternates crashing and completed searches keeps the crash counter low (each completed search resets it), so it pays ≥ 0.5 s backoff plus a full engine start per crash instead of an exponentially growing delay — acceptable while §2.1 makes engine-terminating input unreachable; the backoff mainly protects against a bad binary.

### 2.5 Information leakage — Low, fixed

Public `/health` exposed per-engine busy/idle counts and the session count (tells anyone whether other people are analysing). *Fix:* `/health` → `{status, version}`; `/health/detail` keeps the statistics and is only served on the loopback listener (nginx proxies exactly `/health`; `https://c.referee.at/health/detail` falls through to the SPA). Error messages to clients are fixed strings plus validated ids; no paths, stack traces or stderr reach a client (engine stderr goes to the journal, capped at 20 lines × 500 chars). `serverVersion` is `0.0.0` and is part of the protocol (`welcome`). Logs: the client IP (`X-Real-IP`) at `info` on connect, FENs only at `debug`, `hello.client` at `debug`. nginx has `server_tokens off` globally.

### 2.6 Supply chain — Medium, fixed

`scripts/fetch-engines.sh` downloaded the latest Stockfish release and verified its sha256 **only if `jq` was installed** — it is not on the production host, so the live binary was installed unverified. *Fix:* digest parsing via `jq` or `node`; the download must match GitHub's published digest and, when set, `STOCKFISH_SHA256`; only `github.com`/`objects.githubusercontent.com` URLs; fails closed unless `--no-verify`; `VERSION` records the digest. Tested: wrong `STOCKFISH_SHA256` aborts before the download, a malformed one is rejected, the real `sf_19` asset verifies (`9defc0d4…611f`, the same asset the live binary came from). The Docker image pins `STOCKFISH_VERSION=sf_19` plus that digest. Already fine: `pnpm-lock.yaml` carries integrity hashes and both deploy scripts and Dockerfiles install with `--frozen-lockfile`; `stockfish@19.0.1` pinned exactly; `packageManager` pins pnpm.

### 2.7 Host and container hardening — Low, fixed

- **systemd** (`deploy/chesslab-server.service`, applied live, score 6.4 → see §3): `CapabilityBoundingSet=` / `AmbientCapabilities=` (none), `SystemCallFilter=@system-service` with `SystemCallErrorNumber=EPERM` and `SystemCallArchitectures=native`, `IPAddressDeny=any` + `IPAddressAllow=localhost` (the server never needs egress), `ProtectProc=invisible`, `ProtectClock`, `ProtectHostname`, `ProtectKernelLogs`, `RestrictNamespaces`, `RestrictRealtime`, `RemoveIPC`, `UMask=0077`. Kept off on purpose: `MemoryDenyWriteExecute` (V8 JIT), `ProcSubset=pid` (Stockfish/libuv read `/proc/cpuinfo`, `/proc/stat`, `/proc/meminfo`), `PrivateUsers` (not needed, breaks nothing but adds no value as a plain user). `ProtectSystem=strict` + `ProtectHome=read-only` already make the filesystem immutable for the service.
- **nginx**: `limit_req` on `/ws`; `Content-Security-Policy: frame-ancestors 'none'` (clickjacking) on every response, repeated in the locations that declare their own `add_header` (nginx inheritance rule); all security headers use `always`. The repo copy `deploy/nginx/c.referee.at.conf` had been committed **empty** (47cffbf); it is restored from the live file (pre-certbot form) so the repo is the source of truth again.
- **Docker**: `server` runs `read_only` with a 64 MB `/tmp` tmpfs, `cap_drop: ALL`, `no-new-privileges`; `web` keeps only `CHOWN/SETGID/SETUID/NET_BIND_SERVICE` (nginx master) and `no-new-privileges`; `docker/nginx.web.conf` mirrors the production limits and headers.

### 2.8 Client side — no change

COOP `same-origin` + COEP `require-corp` + CORP `same-origin` are required for threaded WASM and also isolate the page from cross-origin windows (no `window.opener` access, Spectre mitigation). `window.__chesslab` (`apps/web/src/engine/devHook.ts`) only exposes factories for code the page already ships; it grants nothing that an XSS would not already have, so it is harmless in production. `localStorage` holds theme, board/piece settings and analysis settings — no secrets, no personal data. The engine files are same-origin (ADR-005), so CSP work later (§4) can use `'self'` plus `'wasm-unsafe-eval'` and `blob:` for workers.

## 3. Controls in place (after this review)

| Layer | Control |
|---|---|
| Protocol | Zod schemas with hard bounds; Stockfish-equivalent FEN validation; no free-form UCI options; 16 KiB frames; outgoing validation |
| Server | Origin policy (403); `hello` handshake + timeout; per-connection rate limits; per-connection/per-IP/global session caps; wall-clock cap; backpressure; `shell: false` spawns; allow-listed options; crash isolation per lease; exponential respawn backoff with `degraded` state; graceful shutdown kills the cgroup |
| nginx | TLS (certbot), `limit_conn 10`, `limit_req 5r/s burst 20`, 429s, `/health` only, COOP/COEP/CORP, nosniff, Referrer-Policy, `frame-ancestors 'none'`, `server_tokens off` |
| systemd | unprivileged user, no capabilities, seccomp `@system-service`, no egress, read-only FS, private /tmp and /dev, `ProtectProc`, `MemoryMax`, `TasksMax`, `KillMode=control-group` |
| Docker | non-root, read-only, `cap_drop ALL`, `no-new-privileges`, tini, pinned Stockfish release + digest |
| Supply chain | lockfile integrity, frozen installs, pinned `stockfish@19.0.1`, verified engine download |

`systemd-analyze security chesslab-server`: **6.4 MEDIUM → 1.4 OK** (2026-10-23). The remaining flagged items — `PrivateUsers`, `ProcSubset`, `MemoryDenyWriteExecute`, `SystemCallFilter=~@resources/@privileged`, `PrivateNetwork`, `RootDirectory` — are intentionally left open for Node/Stockfish and the loopback listener.

## 4. Residual risks and recommendations

The two P1 items (per-IP session cap, engine respawn backoff) are done, see §2.4 and ADR-008 addendum.

| Prio | Item | Effort | Notes |
|---|---|---|---|
| P2 | **Full Content-Security-Policy** for the SPA (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'`) | 0.5 d | Must be tested with the WASM worker and chessground inline styles; start in `Content-Security-Policy-Report-Only`. |
| P2 | **Pin Docker base images by digest** (`node:22-bookworm-slim@sha256:…`, `nginx:alpine@sha256:…`, `debian:bookworm-slim@sha256:…`) and add a renovate/dependabot job | 0.25 d | Tags are mutable; digests make the image reproducible. |
| P2 | **Hash change throttling**: ignore `hash` changes within N s per session (keep the last value) | 0.25 d | Removes the 512 MB re-allocation per `analyze`; bounded today by the analyze rate. |
| P2 | **CI supply chain**: pin GitHub Actions by commit SHA, enable `pnpm audit` in CI, Dependabot for npm | 0.25 d | `actions/*@v4` tags are mutable. |
| P3 | **HSTS** (`max-age=31536000`) once the certbot setup is considered permanent | 0.1 d | Deliberately off (ADR-002); revisit. |
| P3 | **Structured abuse logging**: count 403/429/`rate_limited` per IP, feed fail2ban | 0.5 d | Only useful once there is traffic. |
| P3 | **IP logging policy**: hash or drop `X-Real-IP` at `info` level if logs are retained long-term | 0.1 d | Privacy hygiene; journal retention on the host is the real knob. |
| P3 | **Fairy-Stockfish** (when enabled): repeat §2.1 against its validator before exposing variants | 0.5 d | Different engine, different `Position::set`. |

## 5. How to re-verify

```bash
pnpm --filter @chesslab/engine-core test     # isValidFen rules
pnpm --filter @chesslab/server test          # origin.test.ts, clientIp.test.ts, ws.test.ts "Origin check"/"per-IP session cap", EnginePool "respawn backoff"
node deploy/ws-smoke.mjs                     # end-to-end through nginx
node deploy/ws-limits-check.mjs              # third session from one address → no_capacity
curl -s http://127.0.0.1:8580/health/detail  # per engine: crashes, backoffUntil, degraded
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example' -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://c.referee.at/ws                    # 403
sudo systemd-analyze security chesslab-server
STOCKFISH_VERSION=sf_19 STOCKFISH_SHA256=0000…0000 bash scripts/fetch-engines.sh --force  # must abort
```
