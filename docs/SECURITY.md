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

### 2.8 Client side — Content-Security-Policy, fixed (M10-1)

COOP `same-origin` + COEP `require-corp` + CORP `same-origin` are required for threaded WASM and also isolate the page from cross-origin windows (no `window.opener` access, Spectre mitigation). `window.__chesslab` (`apps/web/src/engine/devHook.ts`) only exposes factories for code the page already ships; it grants nothing that an XSS would not already have. `localStorage` holds theme, board/piece settings and analysis settings — no secrets, no personal data.

**CSP (enforced since 2026-10-23).** Single source: `apps/web/csp.config.mjs` (`PRODUCTION_CSP`). nginx (`deploy/nginx/c.referee.at.conf`, `docker/nginx.web.conf`) holds a copy in `map $host $chesslab_csp` and sends it on every response (including `/assets/`, so the engine Workers get the same policy); `node scripts/check-csp.mjs [live conf]` fails on drift and runs in CI. `vite preview` sends the same policy (plus loopback `ws:` for the e2e engine servers, `'report-sample'` and a `report-uri`), so every Playwright spec runs under it.

```
default-src 'self'; script-src 'self' 'sha256-YOswKRJVs+FwLZbQstA9GmeqiOLqFnNMWa/1cEzxiD0=' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://lichess.org https://explorer.lichess.org https://api.chess.com wss://c.referee.at; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

| Directive | Why |
|---|---|
| `script-src 'self' 'sha256-…'` | The only inline script is the static theme bootstrap in `apps/web/index.html`; its hash is computed from the file. **Editing that script changes the hash** — `check-csp.mjs` (CI) then fails and prints the new nginx line. No `'unsafe-inline'`, no `'unsafe-eval'`. |
| `'wasm-unsafe-eval'` | `WebAssembly.instantiate` in the Stockfish worker. |
| `worker-src 'self'` | The engine worker is `new Worker(<same-origin URL>)`; Emscripten pthread workers are spawned from the worker's own script URL (`mainScriptUrlOrBlob` unset), verified live: 6 pthread workers from `/assets/engine/…/stockfish-19-lite.js`. No `blob:` needed. |
| `style-src 'self'` | CSS files only. React `style` props and chessground write through the CSSOM, which CSP does not govern; no `<style>`/`style=""` injection in the production build (dev server gets no CSP — Vite injects inline styles/scripts for HMR). |
| `img-src 'self' data:` | Piece sets and chessground board SVGs are `data:` URIs. |
| `connect-src` | Same-origin engine WebSocket (`wss://c.referee.at` listed explicitly for browsers without CSP3 `'self'`→`wss:` matching), lichess and chess.com APIs for the online import; `https://explorer.lichess.org` for the position explorer (M12-2; browser requests with the user's own lichess token as `Authorization: Bearer`, see the apps/web README). The Docker image uses the same list. A different deployment host needs its own `wss://` origin. |
| `object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` | Plugin, `<base>` and form hijacking; clickjacking. |

Rollout: Report-Only on the live site first (headless Chromium through the app: board, browser engine to depth, Import/Settings tabs → only the zod probe below), then enforcing; all e2e specs pass under the enforced policy with zero non-benign reports (`apps/web/e2e/csp-violations.ts` fails the run otherwise).

*Known benign report:* zod v4 probes for JIT support with `new Function("")` in a try/catch and falls back to its interpreter; the probe is blocked and reported (`script-src`, `eval`, sample `(function anonymous(\n) {\n\n})`). Nothing breaks; the e2e check allow-lists exactly that sample. Removing it needs `z.config({ jitless: true })` at app start (open, §4).

### 2.9 Transport, supply chain and abuse logging — fixed (M10-1)

- **HSTS** on `c.referee.at`: `Strict-Transport-Security: max-age=31536000` on every response, without `includeSubDomains`/`preload` (other `referee.at` subdomains are not ours). The certbot setup is permanent (renewal timer), which was the condition in ADR-002. Undo requires serving `max-age=0` for a while — browsers remember for a year.
- **Docker base images pinned by digest**: `node:22-bookworm-slim@sha256:de170b39…`, `debian:bookworm-slim@sha256:7ff6ba31…`, `nginx:alpine@sha256:a3554c0d…` (multi-arch index digests, 2026-10-23; tag kept in the `FROM`). Refresh command in the Dockerfile header. `STOCKFISH_VERSION=sf_19` + `STOCKFISH_SHA256` were already pinned (verified).
- **GitHub Actions pinned by commit SHA**: `actions/checkout` v7.0.1, `pnpm/action-setup` v6.1.0 (pnpm 12 support), `actions/setup-node` v7.1.0, `actions/cache` v6.1.0; workflow `permissions: contents: read`. The `e2e` job fetches the pinned, digest-verified Stockfish (`STOCKFISH_VERSION`/`STOCKFISH_SHA256` as in the Dockerfile) into a cache keyed by version + digest, and caches Playwright browsers keyed by the Playwright version.
- **Abuse logging**: nginx `log_format chesslab` → `/var/log/nginx/c.referee.at.access.log` (rotated by the stock `/etc/logrotate.d/nginx`): address, time, method, **path without query string** (tokens in URLs never hit the log), status, bytes, `rt=` request time, `urt=` upstream time, `Origin`, User-Agent. No bodies. Per-IP counting: `awk '$5 ~ /^\/ws/ && ($7==403||$7==429) {print $1}' … | sort | uniq -c | sort -rn` (field numbers per the format). `deploy/fail2ban/` ships a filter (403/429 on `/ws`) and a jail (30 in 60 s → 10 min ban); fail2ban is **not installed** on the host, so nothing is active — see `deploy/README.md`.

## 3. Controls in place (after this review)

| Layer | Control |
|---|---|
| Protocol | Zod schemas with hard bounds; Stockfish-equivalent FEN validation; no free-form UCI options; 16 KiB frames; outgoing validation |
| Server | Origin policy (403); `hello` handshake + timeout; per-connection rate limits; per-connection/per-IP/global session caps; wall-clock cap; backpressure; `shell: false` spawns; allow-listed options; crash isolation per lease; exponential respawn backoff with `degraded` state; graceful shutdown kills the cgroup |
| nginx | TLS (certbot), HSTS (1 year, no subdomains), `limit_conn 10`, `limit_req 5r/s burst 20`, 429s, `/health` only, COOP/COEP/CORP, nosniff, Referrer-Policy, full enforced CSP (§2.8), `server_tokens off`, per-vhost access log with timings (no query strings) |
| systemd | unprivileged user, no capabilities, seccomp `@system-service`, no egress, read-only FS, private /tmp and /dev, `ProtectProc`, `MemoryMax`, `TasksMax`, `KillMode=control-group` |
| Docker | non-root, read-only, `cap_drop ALL`, `no-new-privileges`, tini, base images pinned by digest, pinned Stockfish release + digest, same CSP as production |
| Supply chain | lockfile integrity, frozen installs, pinned `stockfish@19.0.1`, verified engine download, GitHub Actions pinned by SHA, least-privilege `GITHUB_TOKEN` |
| Browser | enforced CSP (hash-allowed inline script only, `'wasm-unsafe-eval'`, no `unsafe-*`), checked in CI and under every e2e spec |

`systemd-analyze security chesslab-server`: **6.4 MEDIUM → 1.4 OK** (2026-10-23). The remaining flagged items — `PrivateUsers`, `ProcSubset`, `MemoryDenyWriteExecute`, `SystemCallFilter=~@resources/@privileged`, `PrivateNetwork`, `RootDirectory` — are intentionally left open for Node/Stockfish and the loopback listener.

## 4. Residual risks and recommendations

The two P1 items (per-IP session cap, engine respawn backoff) are done, see §2.4 and ADR-008 addendum. Done in M10-1 (2026-10-23): full CSP (§2.8), HSTS, Docker digests, Actions pinned by SHA, abuse logging + fail2ban example (§2.9).

| Prio | Item | Effort | Notes |
|---|---|---|---|
| P2 | **Hash change throttling**: ignore `hash` changes within N s per session (keep the last value) | 0.25 d | Removes the 512 MB re-allocation per `analyze`; bounded today by the analyze rate. |
| P2 | **Dependency update automation**: Dependabot/Renovate for npm, Docker digests and Actions SHAs; `pnpm audit` in CI | 0.25 d | Pins now exist, so updates must be deliberate; without a bot they go stale. |
| P3 | **zod jitless**: `z.config({ jitless: true })` at app start | 0.05 d | Silences the benign CSP report from zod's `new Function` probe (§2.8); then drop the allow-list in `apps/web/e2e/csp-violations.ts`. |
| P3 | **fail2ban**: install and enable `deploy/fail2ban/` once there is traffic | 0.1 d | Files ready; not installed on the host. Engine-level refusals (`rate_limited`, `no_capacity`) are only in the journal, not the access log. |
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
curl -sI https://c.referee.at/ | grep -iE 'content-security|strict-transport|cross-origin'
node scripts/check-csp.mjs /etc/nginx/sites-available/c.referee.at   # repo + live nginx carry PRODUCTION_CSP
pnpm e2e                                     # all specs under the enforced CSP; fails on any violation report
```
