# Deployment: https://play.daisychess.org

Single host (Debian 13), nginx + Let's Encrypt. See `docs/DECISIONS.md` ADR-001 (ports), ADR-002
(hosting model), ADR-008 (security policies) and ADR-021 (move to
daisychess.org); the threat model and hardening checklist are in `docs/SECURITY.md`.

| What                      | Where                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Web app build             | `/var/www/play.daisychess.org` (owner `bojan:bojan`), `deploy/deploy-web.sh`                                                             |
| Operator portal build     | `/var/www/play.daisychess.org/portal/`, `deploy/deploy-portal.sh`                                                                        |
| Shared nginx declarations | `deploy/nginx/daisychess-common.conf` → `/etc/nginx/conf.d/daisychess-common.conf` (CSP maps, `log_format daisychess`, rate-limit zones) |
| App vhost                 | `deploy/nginx/play.daisychess.org.conf` → `/etc/nginx/sites-available/play.daisychess.org`                                               |
| Hub link vhost            | `deploy/nginx/hub.daisychess.org.conf` → `/etc/nginx/sites-available/hub.daisychess.org` (`/link`, `/health` only)                       |
| TLS cert                  | `/etc/letsencrypt/live/daisychess.org/` (daisychess.org, www, play, hub)                                                                 |
| Engine server             | `127.0.0.1:8580`, proxied at `/ws`, `/link`, `/api/portal/` and `/health` (`/health/detail` is loopback-only)                            |
| Server unit               | `deploy/daisychess-server.service` (installed by `deploy/deploy-server.sh`)                                                              |

The app sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (multi-threaded WASM), plus CORP,
nosniff, Referrer-Policy, an enforced `Content-Security-Policy` and
`Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, no
preload). `/assets/*` is cached immutably, `index.html` is `no-cache`, unknown
paths fall back to `index.html` (SPA).

The vhost files are complete TLS versions (no certbot `--nginx` run needed: the certificate
lineage exists). They declare no `map`, `log_format` or zone themselves: nginx rejects duplicates,
and a `log_format` must come before its first use, which `conf.d/` guarantees (Debian includes it
before `sites-enabled/`). `node scripts/check-csp.mjs [live files…]` verifies all CSP copies.
Always `sudo nginx -t` before `sudo systemctl reload nginx`.

## Operator portal (`/portal/`)

```bash
deploy/deploy-portal.sh
```

Builds `apps/portal` and rsyncs it to `/var/www/play.daisychess.org/portal/` (`deploy-web.sh`
leaves that directory alone). The API only exists on a `ROLE=hub` server with
`PUBLIC_ORIGIN=https://play.daisychess.org`, `HUB_ADMIN_LICHESS` and the lichess egress proxy
(ADR-020). lichess OAuth client id: `portal.daisychess.org` (public PKCE client; lichess needs no
registration; redirect URI `https://play.daisychess.org/portal/`). Node snippets show
`HUB_URL=wss://hub.daisychess.org/link` on play.daisychess.org (`apps/portal/src/format.ts`);
`VITE_HUB_URL` at build time overrides it, other hosts derive `wss://<host>/link`.

## Redeploy the web app

```bash
deploy/deploy-web.sh
```

Runs `pnpm install --frozen-lockfile`, `pnpm --filter @daisychess/web build`,
then `rsync -a --delete --exclude /portal/ --exclude /puzzles/ apps/web/dist/ /var/www/play.daisychess.org/`
(`/puzzles/` belongs to `deploy/deploy-puzzles.sh`, see "Puzzle data"). No nginx reload needed.
Android App Links (ADR-022 §4): after the rsync it writes
`/var/www/play.daisychess.org/.well-known/assetlinks.json` from `deploy/assetlinks.json.template` when
`PLAY_SIGNING_SHA256` is set in the environment (Play Console, Setup, App signing, SHA-256 certificate
fingerprint, `AA:BB:...`; several comma-separated values are allowed, e.g. for the upload key during
testing), for example `PLAY_SIGNING_SHA256=AA:BB:... deploy/deploy-web.sh`. Without it an existing
file is kept and none is created (the repo variable `PLAY_SIGNING_SHA256` of M26-9 is the source of
the value). `public/.well-known/apple-app-site-association` (Team ID `PM7LTV7M72`) ships with the
build; nginx serves both files from the exact locations in `deploy/nginx/play.daisychess.org.conf`
(reload needed once when these locations are first installed).
The build includes the opt-in full-strength Stockfish build
(`assets/engine/stockfish-<version>/stockfish-19.wasm`, ~99 MB; ADR-010), so `dist/`
is ~105 MB; browsers fetch it only when a user enables "maximum strength".

## Puzzle data

Curated lichess puzzles (ADR-023; CC0 data from <https://database.lichess.org/#puzzles>) are static
files under `/var/www/play.daisychess.org/puzzles/v1/`: `shards/<band>-<16 hex>.json` (content-addressed,
cached immutably) and `index.json` (cached 1 h). The web app fetches them from its own origin, the
mobile apps from `https://play.daisychess.org/puzzles/v1/` (CORS for the app origins only). Without
the files the app falls back to the bundled starter set (`apps/web/src/puzzles/data/starter.json`).

Run by hand after each monthly lichess dump (owner decision, ADR-023 addendum):

```bash
deploy/deploy-puzzles.sh             # download if new, verify, build, publish, prune
deploy/deploy-puzzles.sh --dry-run   # download/verify and build, print the counts, write nothing
```

What it does:

1. Fetches `https://database.lichess.org/sha256sums.txt` and downloads `lichess_db_puzzle.csv.zst`
   (≈ 307 MB) into `${PUZZLE_CACHE_DIR:-~/.cache/daisychess/puzzles}` only when the cached copy is
   missing or the listed digest changed; `curl -C -` resumes an interrupted download of the same
   dump (a partial file of an older dump is discarded).
2. Verifies the dump fail-closed against that digest on every run (cached copies too) and, when
   `LICHESS_PUZZLE_SHA256` is set, against that pin as well. A mismatch deletes the download and
   publishes nothing.
3. Runs `pnpm install --frozen-lockfile` (skip with `--no-install`), builds `@daisychess/puzzles`
   and `node packages/puzzles/scripts/build-puzzles.mjs` into a temp directory: hard filter
   (popularity ≥ 90, RD ≤ 80, ≥ 300 plays, rating ≥ 500, 2…20 plies, FEN ≤ 100 chars), 16,000 most
   played per 100-point band plus a floor of 600 per theme, chess.js legality of every selected
   line, shards of ≤ 2,000 rows, then `index.json`; the starter (6,000 rows, daily pool, ≤ 1 MB,
   asserted) and `SOURCE.md` are written to `apps/web/src/puzzles/data/`. It prints the counts per
   band and theme and the peak RSS.
4. rsyncs the shards first and `index.json` last into `${PUZZLE_ROOT:-/var/www/play.daisychess.org/puzzles/v1}`
   **without `--delete`**: a client with a cached index keeps resolving its shards. Shards the new
   index no longer names are recorded in `$PUZZLE_CACHE_DIR/unreferenced.txt` and deleted once
   they have been unreferenced for more than `PUZZLE_PRUNE_DAYS` (default 30) days.
5. Prints the next steps: review and commit `starter.json` + `SOURCE.md`, redeploy the web app
   (`deploy/deploy-web.sh`); the mobile apps get the new starter with their next release.

Measured on a synthetic input of the full size (6.1 M rows, the 12 MB sample repeated): peak RSS
1.34 GB, 2.3 minutes on 16 cores (legality checks run in up to 8 worker threads); the script runs
node with `--max-old-space-size=2048` so a regression fails instead of swapping. Output ≈ 300 k
puzzles in ≈ 170 shards (≈ 43 MB raw, gzip on the wire).

Development: `deploy/deploy-puzzles.sh --sample 12000000` makes a ranged download of the first
12 MB (no digest to verify), builds only the starter (`PUZZLE_STARTER=<path>` writes it elsewhere)
and publishes nothing. The build script also runs directly:
`node packages/puzzles/scripts/build-puzzles.mjs --input <file.csv.zst|file.csv> --out <dir> [--starter <path>] [--sample <bytes>] [--sha256 <hex>] [--dry-run]`.
The pipeline falls back to the `zstd` CLI when `zlib.createZstdDecompress` is missing (Node < 22.15).

nginx (once): the map `$daisychess_app_cors` in `daisychess-common.conf` (echoes exactly
`https://app.daisychess.org` and `capacitor://app.daisychess.org`) and the locations
`/puzzles/v1/shards/`, `= /puzzles/v1/index.json` and `/puzzles/` in `play.daisychess.org.conf`
(full header group with CORP `cross-origin`, `Access-Control-Allow-Origin $daisychess_app_cors`,
`Vary: Origin`). `node scripts/check-csp.mjs` checks both. Verify after a reload:

```bash
curl -sI -H 'Origin: https://app.daisychess.org' https://play.daisychess.org/puzzles/v1/index.json
# 200, Cache-Control: public, max-age=3600, Access-Control-Allow-Origin: https://app.daisychess.org,
# Vary: Origin, Cross-Origin-Resource-Policy: cross-origin, Content-Type: application/json
curl -sI -H 'Origin: https://evil.example' https://play.daisychess.org/puzzles/v1/index.json
# no Access-Control-Allow-Origin
```

## Elo calibration

The review's offline Elo fallback (ADR-024 §5) maps a side's mean win-probability loss to a
rating through `apps/web/src/review/data/eloCalibration.json`. The table is fitted on one lichess
monthly database dump by `apps/web/scripts/calibrate-elo.mjs`; this is an owner-run step like
the puzzle pipeline, never run in CI. Run it on the host, then commit the result:

```bash
deploy/calibrate-elo.sh --range 2000000000            # ranged 2 GB of last month's dump (≈ 25 min)
deploy/calibrate-elo.sh --month 2026-09 --range 2000000000 --dry-run   # print the table only
```

What it does:

1. Fetches `https://database.lichess.org/standard/sha256sums.txt` and the digest of
   `lichess_db_standard_rated_YYYY-MM.pgn.zst` (`--month`, default the previous month; a month
   lichess does not list fails).
2. Downloads into `${PUZZLE_CACHE_DIR:-~/.cache/daisychess/puzzles}`:
   - `--range BYTES`: only the first BYTES (`curl -r`, resumed from the cached prefix). A prefix
     cannot be verified against the digest of the whole dump; that digest is recorded with the
     prefix and in `SOURCE.md`, and a cached prefix of another dump version is discarded. A
     server that ignores the range fails the run.
   - without `--range`: the whole dump (≈ 29 GB for 2026-09 — **more than the host's free disk**,
     so use `--range`), resumable, verified fail-closed against the listed digest on every run.
     Both refuse to start when the download would leave less than `FREE_SPACE_MARGIN_MB` (2048) free.
3. Builds engine-core (`pnpm install --frozen-lockfile` first unless `--no-install`) and runs the
   script: it streams the dump (`zlib.createZstdDecompress` on Node ≥ 22.15, else the `zstd` CLI
   as a child process — Node 24 on the host has zlib zstd, nothing to install), keeps rated
   standard games with lichess's `[%eval]` annotations and established ratings of both players
   (`RatingDiff` present), replays them with chess.js in worker threads (`CALIBRATE_JOBS`, default
   cores − 1, at most 8), reproduces the app's review (`reviewGame`) and Elo position selection
   (`selectEloPlies`, book end as in `openingFocus.ts`), and fits per speed class an isotonic
   regression of rating on mean loss (≤ 24 knots, residual sd). Classes with fewer than
   `CALIBRATE_MIN_SAMPLES` (1000) samples are left out (the app uses the pooled `unknown` curve).
   It prints the counts and the table (rating at 1/2/4/6/8/12/16 % mean loss per class).
4. Writes `eloCalibration.json` and `SOURCE.md` to `apps/web/src/review/data/`
   (`ELO_CALIBRATION_OUT=<path>` writes elsewhere) and prints the next steps: commit both files,
   redeploy the web app (`deploy/deploy-web.sh`).

Measured on the first 8 MB of the 2026-09 dump (2 546 evaluated and eligible games, 10.5 % of the 24 231 read,
8 threads): ≈ 450 games/s, peak RSS ≈ 0.9 GB. A 2 GB range holds ≈ 6 M games, ≈ 600 k of them
evaluated: ≈ 25 minutes and ≈ 1.2 M samples (`--limit GAMES` stops earlier; 100 k games are
plenty for the table). `--limit`, `--dry-run` and the direct call also work:
`node apps/web/scripts/calibrate-elo.mjs --input <file.pgn.zst|file.pgn> --out <json> [--month YYYY-MM] [--sample <bytes>] [--limit <games>] [--sha256 <hex>]`.

The committed table until the first real run is **provisional** (`source.month: "provisional"`,
fitted on that 8 MB sample; the app calls the estimate rough).

## Engine server

Systemd unit `daisychess-server` (user `bojan`, `127.0.0.1:8580`), deployed on 2026-10-23.

```bash
deploy/deploy-server.sh
```

Runs `pnpm install --frozen-lockfile`, builds `engine-core` and `server`, runs
`pnpm fetch-engines` (idempotent), installs `deploy/daisychess-server.service` to
`/etc/systemd/system/`, `daemon-reload`, `enable` + `restart`, then waits up to
10 s for `http://127.0.0.1:8580/health/detail` and prints it. Needs `sudo`.

**Rename to DaisyChess (ADR-018).** The unit was called differently before the
rename; the first run of `deploy/deploy-server.sh` after it stops, disables and
removes the old unit (`LEGACY_UNIT` in the script) before installing
`daisychess-server`, so nothing else has to be done for the server
(`apps/server/.env.production` is unchanged). For the web app, run
`deploy/deploy-web.sh` and apply the nginx files to the installed
site (new CSP hash of the inline theme script, renamed `log_format`/`limit_*`
zones/CSP map variable, `location = /manifest.webmanifest`), keeping the certbot
lines, then `sudo nginx -t && sudo systemctl reload nginx`;
`node scripts/check-csp.mjs /etc/nginx/conf.d/daisychess-common.conf /etc/nginx/sites-available/play.daisychess.org` verifies the CSP.

Verify:

```bash
systemctl status daisychess-server
curl -s https://play.daisychess.org/health     # {status, version} only
curl -s http://127.0.0.1:8580/health/detail   # pool stats, sessions, connections (loopback)
node deploy/ws-smoke.mjs            # hello -> analyze depth 12 -> bestmove (Node 22+)
# with ACCESS_TOKEN set: without the token the smoke test fails (restricted welcome, `unauthorized`)
DAISYCHESS_TOKEN="$(sed -n 's/^ACCESS_TOKEN=//p' apps/server/.env.production)" node deploy/ws-smoke.mjs
```

**Limits and config.** The server does not read `.env` itself; the unit loads
`apps/server/.env.production` via `EnvironmentFile=-` (optional file, not
created by the script; copy from `apps/server/.env.example`; currently
`MAX_SESSIONS=4`, `MAX_THREADS=4`, `LOG_LEVEL=info`). The unit itself sets
`ALLOWED_ORIGINS=https://play.daisychess.org,https://app.daisychess.org,capacitor://app.daisychess.org`
(ADR-008: browser origins allowed on `/ws`; other origins get 403 at the upgrade. The two
`app.daisychess.org` entries are the WebView origins of the Android and iOS apps, ADR-022;
`capacitor://` entries are only accepted in an explicit list, and only by a server build that
has M26-2 — an older build refuses to start with them). Edit it, then
`sudo systemctl restart daisychess-server`. Per-engine defaults and
`maxInstances` live in `apps/server/engines.json`. Resource caps (`MemoryMax`,
`CPUWeight`, `TasksMax`) are in the unit; after editing it, rerun the script.
The unit is read-only on the filesystem (`ProtectSystem=strict`,
`ProtectHome=read-only`) except `ReadWritePaths=/home/bojan/gitchess/apps/server/data`,
the review store (next paragraph).

**Review store (ADR-017).** Finished game reviews and position evaluations are
kept in `apps/server/data/reviews.sqlite` (SQLite via `node:sqlite`, Node ≥ 22.13;
the host runs 24). The server creates the directory and file on start
(`UMask=0077`: `drwx------ bojan`). Only moves and evaluations are stored — no
PGN headers, names or addresses — and everything is **reproducible** (a missing
review is simply computed again), so the file needs **no backup**; delete it
while the service is stopped to start over. Disk use is capped by
`REVIEW_STORE_MAX_BYTES` in `apps/server/.env.production` (default 5 GB; least
recently used positions, then reviews, are evicted down to 90 %); the cap is a
payload estimate, so allow ~20 % slack plus up to 4 MB of WAL. Writes need the
access token and are capped per address (`REVIEW_PUT_PER_IP_PER_DAY`, 500/day).
`REVIEW_STORE=off` disables it. Check it with
`curl -s http://127.0.0.1:8580/health/detail | jq .reviewStore`
(`{enabled, reviews, positions, bytes, maxBytes}`); the file itself can be
inspected with `sqlite3 apps/server/data/reviews.sqlite 'select count(*) from reviews'`.
If the unit is updated from an older install, the `ReadWritePaths=` line is what
makes the directory writable — without it the server logs
"review store unavailable" and runs without the feature.

**Lc0 + Maia, human-like engines (ADR-019).** `deploy/deploy-server.sh` runs
`pnpm fetch-engines` (now also the nine Maia nets, ~12 MB, into `engines/maia/`,
sha256-pinned to a commit of github.com/CSSLab/maia-chess; provenance and licence
in `engines/maia/SOURCE.md`) and `pnpm build-lc0` (Lc0 v0.32.1 from the pinned,
sha256-verified source tarball, CPU-only Eigen backend, portable SSE4.2/POPCNT code
so it runs on this VM without AVX2; ~30 s wall on 16 cores, 2.4 MB binary in
`engines/lc0/`, build log in `engines/lc0/VERSION`). Both are idempotent and skip
when the files are present with matching checksums/version. Build dependencies,
installed on the host on 2026-10-25: `meson`, `libeigen3-dev`, `libopenblas-dev`
(unused by the Eigen build, harmless), plus the already present `ninja-build`,
`g++`, `python3`, `pkg-config`, `zlib1g-dev`. The build needs network access for
the two tarballs and meson's abseil-cpp subproject (hash-verified wrap). No unit
change is needed: the binary and weights live under the read-only `/home` mount
and the process needs only `@system-service` syscalls. Runtime: one Lc0 process
per active Maia level (~16 MB RSS, 2 threads; a 1-node move takes ~1 ms), at most
`MAIA_MAX_PROCESSES` (default 3) for all levels together; `MAIA=off` in
`apps/server/.env.production` disables them. Verify after a deploy:
`curl -s http://127.0.0.1:8580/health/detail | jq '.processGroups, [.engines[] | select(.group=="maia") | {id, enabled}]'`
— every `maia-*` must show `enabled: true`; if not, the journal has one warning
naming the missing file.

**Access token (ADR-010, ADR-013).** If `ACCESS_TOKEN` is set in
`apps/server/.env.production` (git-ignored, mode 600), a client must send it in
`hello.token` to analyse; otherwise it gets a restricted `welcome` (no engines,
`capabilities.analysis: false`) and `error unauthorized` on every `analyze`, while
"play a friend" rooms (`room.*`) work without a token. Empty or unset = public
server. The token is never logged. Users enter
it once in the web app (Settings → "Server access token"; stored in the
browser's `localStorage`). Rotate it:

```bash
sed -i "s/^ACCESS_TOKEN=.*/ACCESS_TOKEN=$(openssl rand -hex 16)/" apps/server/.env.production
sudo systemctl restart daisychess-server
DAISYCHESS_TOKEN="$(sed -n 's/^ACCESS_TOKEN=//p' apps/server/.env.production)" node deploy/ws-smoke.mjs
```

Then hand the new value to the users (old tokens stop working immediately;
open connections stay until they reconnect).

Abuse-relevant limits (production values; all env vars are documented in
`apps/server/.env.example`, the rationale in `docs/SECURITY.md`):

| Limit                                    | Value                                                                                          | Where                                                               | Over the limit                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| WebSocket connections per IP             | 10                                                                                             | nginx `limit_conn`                                                  | 429                                                               |
| Handshakes per IP                        | 5/s, burst 20                                                                                  | nginx `limit_req`                                                   | 429                                                               |
| Engine sessions, global                  | 4                                                                                              | `MAX_SESSIONS`                                                      | `no_capacity`                                                     |
| Review reads / writes per connection     | 20/s / 20 per 4 s                                                                              | connection rate limits                                              | `rate_limited`                                                    |
| Review writes per IP and day             | 500                                                                                            | `REVIEW_PUT_PER_IP_PER_DAY`                                         | `review.stored … quota`                                           |
| Review store on disk                     | 5 GB                                                                                           | `REVIEW_STORE_MAX_BYTES`                                            | LRU eviction to 90 %                                              |
| Engine sessions per IP (all connections) | 2                                                                                              | `MAX_SESSIONS_PER_IP` (client IP = `X-Real-IP` from loopback nginx) | `no_capacity` "too many sessions from your address"               |
| Sessions per connection                  | 2                                                                                              | `MAX_SESSIONS_PER_CONNECTION`                                       | `limit_exceeded`                                                  |
| Instances per engine                     | 3                                                                                              | `engines.json` `maxInstances`                                       | `no_capacity`                                                     |
| Lc0 processes, all Maia levels together  | 3                                                                                              | `MAIA_MAX_PROCESSES` (idle ones are replaced first)                 | `no_capacity` "all 3 process(es) of engine group "maia" are busy" |
| Nodes per `analyze`                      | 10 000 (Maia entries: 1)                                                                       | `MAX_NODES`, `engines.json` `maxNodes`                              | `limit_exceeded`                                                  |
| Respawn after a crash                    | 0.5 s doubling to 30 s (±20 %), reset after 60 s up or a completed search; `degraded` after 10 | `ENGINE_CRASH_RESET_MS`, `ENGINE_MAX_CONSECUTIVE_CRASHES`           | `no_capacity` "restarting after a crash"                          |
| `analyze` / all messages                 | 20/s / 100/s per connection                                                                    | server                                                              | `rate_limited` / close 1008                                       |

`/health/detail` shows per engine `crashes`, `backoffUntil` and `degraded`, and
`clientAddresses` (addresses currently holding engine sessions).
`node deploy/ws-limits-check.mjs` verifies the per-IP cap end to end (the third
session from one address must get `no_capacity`; prefix `DAISYCHESS_TOKEN=…` when
the server requires a token).

**Logs.** JSON lines in the journal (your user needs group `adm` or
`systemd-journal`, otherwise use `sudo`):

```bash
sudo journalctl --namespace=daisychess -u daisychess-server -n 50 --no-pager
sudo journalctl --namespace=daisychess -u daisychess-server -f
```

The unit logs into its own journal namespace `daisychess` (`LogNamespace=`), configured by
`deploy/journald@daisychess.conf` (`MaxRetentionSec=7day`, `SystemMaxUse=200M`, installed to
`/etc/systemd/journald@daisychess.conf` by `deploy/deploy-server.sh`). Without `--namespace`
`journalctl` shows only the default journal, which no longer holds the server's lines.

`/health` requests are not logged by the server, so polling it adds no noise.

**Roll back.**

```bash
git checkout <previous-commit>   # or: git stash / git switch
deploy/deploy-server.sh
```

Stopping the service kills the whole cgroup (`KillMode=control-group`), so no
orphaned `stockfish` processes remain.

**nginx.** `/ws` has `limit_conn daisychess_ws 10` (per IP) and
`limit_req zone=daisychess_ws_req burst=20 nodelay` (5 handshakes/s per IP);
excess gets 429. The `*_zone` lines, the CSP maps and the `daisychess` log format sit in
`/etc/nginx/conf.d/daisychess-common.conf` (http context, source
`deploy/nginx/daisychess-common.conf`); the vhost files only reference them. The repo files are
the complete live versions (TLS included): apply a change by copying the file over the installed
one, then `sudo nginx -t && sudo systemctl reload nginx` (back the live file up first, e.g.
`sudo cp -a /etc/nginx/sites-available/play.daisychess.org{,.bak-$(date +%Y%m%d-%H%M%S)}`).

**Content-Security-Policy.** Built by `apps/web/csp.config.mjs` (policy and
rationale: `docs/SECURITY.md` §2.8). The nginx copy contains the sha256 of the
inline theme script in `apps/web/index.html`; if that script changes, the
browser blocks it until nginx is updated. Check repo and live file with

```bash
node scripts/check-csp.mjs /etc/nginx/conf.d/daisychess-common.conf \
  /etc/nginx/sites-available/play.daisychess.org /etc/nginx/sites-available/hub.daisychess.org
```

which prints the expected `default "…";` line on a mismatch (CI runs it for
the repo files). Deploy the web build and the nginx change together. To
debug a suspected CSP problem, temporarily rename the header to
`Content-Security-Policy-Report-Only` in every place (violations then only
show in the browser console) and keep `add_header Content-Security-Policy
"frame-ancestors 'none'" always;` next to it, since `frame-ancestors` is
ignored in report-only mode.

**HSTS.** One year, per host (play, hub), no `includeSubDomains`. Browsers cache it: going back to plain
HTTP needs `max-age=0` served over HTTPS for a while first.

## Abuse logging and fail2ban

nginx writes `/var/log/nginx/play.daisychess.org.access.log`,
`hub.daisychess.org.access.log` (and `.error.log`) in the
`daisychess` format: address, time, method, path **without query string**,
status, bytes, `rt=` request time, `urt=` upstream time, `Origin`, User-Agent.
No bodies. The stock `/etc/logrotate.d/nginx` rotates it (daily, 14 days).

```bash
# refused WebSocket upgrades per address (403 = foreign Origin, 429 = nginx limits)
sudo awk '$5 ~ /^\/ws/ && ($7 == 403 || $7 == 429) {print $7, $1}' \
  /var/log/nginx/play.daisychess.org.access.log | sort | uniq -c | sort -rn | head
```

Engine-level refusals (`rate_limited`, `no_capacity`, `limit_exceeded`) happen
inside an accepted socket and are only in the server journal.

**The application log holds no raw client addresses** (M24-15): at `info` every line
carries `ipHash` = first 12 characters of `base64url(sha256(dailySalt + ip))`, where the salt is
random per process and UTC day, kept in memory only. Raw addresses appear only at `LOG_LEVEL=debug`
and in nginx's access log above, which is therefore the source for fail2ban (retention: the stock
logrotate, 14 days). Refused `/link` handshakes are `101` + immediate `1008` close, visible in
nginx as a 101 with `rt=0.xxx`.

`deploy/fail2ban/` has two filter/jail pairs: `daisychess-ws` (403/429 on `/ws`; 30 within
60 s → 10 min ban) and `daisychess-link` (429/403 and sub-second 101 on `/link`; 10 within
10 min → 1 h ban). fail2ban is **not installed** on this host (2026-10-23), so the
files are inactive. To enable:

```bash
sudo apt install fail2ban
sudo cp deploy/fail2ban/filter.d/daisychess-*.conf /etc/fail2ban/filter.d/
sudo cp deploy/fail2ban/jail.d/daisychess-*.conf /etc/fail2ban/jail.d/
sudo fail2ban-regex /var/log/nginx/play.daisychess.org.access.log daisychess-ws     # dry run
sudo fail2ban-regex /var/log/nginx/hub.daisychess.org.access.log daisychess-link    # dry run
sudo systemctl restart fail2ban && sudo fail2ban-client status daisychess-ws && sudo fail2ban-client status daisychess-link
```

## Traffic stats

Owner-only [GoAccess](https://goaccess.io) reports at `https://daisychess.org/stats/` (basic auth), one per
site (`daisychess.org`, `play.daisychess.org`, `hub.daisychess.org`), regenerated hourly from the nginx
access logs (`/var/log/nginx/*.access.log` plus the rotated `.N` / `.N.gz`, so at most 14 days). The
"Referring sites" panel shows the `Origin` header: `capacitor://app.daisychess.org` (iOS app),
`https://app.daisychess.org` (Android app), `https://play.daisychess.org` (web). No GoAccess database
is kept, and the reports are static HTML with all scripts and styles inline. Privacy: legitimate
interest, see `apps/site/privacy/index.html` section 5.

```bash
sudo apt install goaccess apache2-utils python3-maxminddb
sudo useradd --system --no-create-home --shell /usr/sbin/nologin --groups adm daisychess-stats
sudo install -d -o daisychess-stats -g www-data -m 0750 /var/www/daisychess-stats
sudo install -D -m 0755 deploy/stats/goaccess-report.sh /usr/local/lib/daisychess/goaccess-report.sh
sudo install -m 0755 deploy/stats/visitors.py deploy/stats/geoip-update.sh /usr/local/lib/daisychess/
sudo install -m 0644 deploy/stats/daisychess-stats.service deploy/stats/daisychess-stats.timer \
  deploy/stats/daisychess-geoip.service deploy/stats/daisychess-geoip.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now daisychess-geoip.timer
sudo systemctl start daisychess-geoip.service     # first country database now; check: journalctl -u daisychess-geoip
sudo systemctl enable --now daisychess-stats.timer
sudo systemctl start daisychess-stats.service   # first report now; check: journalctl -u daisychess-stats

# the owner picks the password (prompted, never put it on a command line or in the repo)
sudo htpasswd -c /etc/nginx/daisychess-stats.htpasswd <user>
sudo chown root:www-data /etc/nginx/daisychess-stats.htpasswd && sudo chmod 0640 /etc/nginx/daisychess-stats.htpasswd

# update /etc/nginx/sites-available/daisychess.org from deploy/nginx/daisychess.org.conf (the /stats/ location)
sudo nginx -t && sudo systemctl reload nginx
```

`/stats/` has its own CSP (`'unsafe-inline'` for script and style, nothing external) because the GoAccess
HTML is self-contained; `node scripts/check-site-csp.mjs` checks the block. Visits to `/stats/` are not
logged. A site without logs is skipped. Manual run into a scratch directory:
`deploy/stats/goaccess-report.sh /var/log/nginx /tmp/stats-out`.

**Countries and visitor classes.** `geoip-update.sh` (monthly via `daisychess-geoip.timer`, falls back to the
previous month) downloads the free [DB-IP](https://db-ip.com) "IP to Country Lite" database (CC BY 4.0, the
attribution is on the stats index page) to `/var/lib/daisychess-stats/dbip-country-lite.mmdb`;
`goaccess-report.sh` then passes `--geoip-database` to GoAccess (Geo Location panel) and without the file
still works. `visitors.py` writes `visitors.html`: every IP of the three sites with country, first/last seen,
requests, sites, top user agent, status mix and a class with its reason (crawler: known bot or non-browser
client; scanner: probe paths such as `wp-login`/`.env`/`*.php`, mostly 4xx or a URL as user agent; likely
human: browser plus assets, WebSocket upgrade or app origin; unknown: browser, HTML only). Full IPs are shown
(password-protected, owner only). The country lookup happens offline on our server, nothing is sent to third
parties. GoAccess keeps crawlers in (no `--ignore-crawlers`) so totals are complete and the Browsers panel has a
"Crawlers" category; the human estimate lives in `visitors.html`. Classifier tests:
`python3 deploy/stats/test_visitors.py` (also run by `pnpm test` in `apps/site` when python3 exists).

## Certificate renewal

Handled automatically by certbot's systemd timer (`certbot.timer`). Check with:

```bash
systemctl list-timers certbot.timer
sudo certbot certificates
sudo certbot renew --dry-run --cert-name daisychess.org
```

## Hub runbook (`ROLE=hub`)

Operations for the hub of ADR-020 (server + `/link` + portal). Reference: `docs/DECISIONS.md` ADR-020 §9 and its addenda, `docs/SECURITY.md` §6, all variables in `apps/server/.env.example` (section 4). Public names (ADR-021): app and portal on `https://play.daisychess.org` (`PUBLIC_ORIGIN`), node link on `wss://hub.daisychess.org/link` (alias `/link` on play). Use `PUBLIC_ORIGIN` and nodes' `HUB_URL`, never hard-code them.

### Deploy order

1. **Backup first** (below), then pull the new code.
2. **nginx**: install the loopback egress proxy (`sudo cp deploy/nginx/lichess-egress.conf.snippet /etc/nginx/conf.d/daisychess-lichess-egress.conf`), install `daisychess-common.conf` and the vhosts (section "Deployment" table above), then `sudo nginx -t && sudo systemctl reload nginx`. Check the proxy: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8581/lichess/api/account` gives `401`. `node scripts/check-csp.mjs <installed files>` must pass.
3. **Portal SPA**: `deploy/deploy-portal.sh`.
4. **Server**: add to `apps/server/.env.production`, keeping `ACCESS_TOKEN` for now, then `deploy/deploy-server.sh`:

   ```bash
   ROLE=hub
   PUBLIC_ORIGIN=https://play.daisychess.org
   ALLOWED_ORIGINS=https://play.daisychess.org,https://app.daisychess.org,capacitor://app.daisychess.org
   HUB_ADMIN_LICHESS=<your lichess username>
   ```

   `hub.sqlite` is created in `apps/server/data/` (already in the unit's `ReadWritePaths`, mode 700). The unit needs no other change: the only outbound call (lichess login) goes through the loopback proxy. Needs Node >= 22.13 (`node:sqlite`).

5. **Verify**: `curl -s http://127.0.0.1:8580/health/detail` shows `role: hub`; `node deploy/ws-smoke.mjs` (with the legacy token) still works; `node scripts/node-smoke-hub.mjs` is the fake hub used by the node image smoke test; register a real node from the portal to test `/link`.

### Minting the first tokens and retiring `ACCESS_TOKEN`

1. Open `https://play.daisychess.org/portal/`, log in with lichess as `HUB_ADMIN_LICHESS` (the first login makes you administrator). The built-in node `local` is listed.
2. Create one player token per device (`dc1_<id>_<secret>`, shown once) with `local` as its node and the `full` tier; open the setup link (or scan the QR code) on each device, which stores it in Settings.
3. Confirm in the portal that each token shows a recent "last used". Only then remove `ACCESS_TOKEN` from `.env.production` and run `sudo systemctl restart daisychess-server`. Until then the old token keeps working (it is logged as `tokenId: legacy`).
4. Community nodes: create a node in the portal, give the operator the `dcn_` token (shown once; "Rotate" keeps the old secret valid for 24 h). Pool tokens: `POOL_TOKENS_PER_OPERATOR` per operator, `POOL_DAILY_BUDGET_MIN` minutes a day each.

### Backups

`hub.sqlite` (operators, nodes, tokens, usage) cannot be recreated, unlike `reviews.sqlite`, which is only a cache of reviews. Use SQLite's online backup, not `cp`, while the server runs (WAL mode). Run it as the service user outside the unit (cron or a systemd timer), because the unit's sandbox is not involved:

```bash
# /home/bojan/gitchess/apps/server/data/backup/ is covered by the unit's ReadWritePaths
mkdir -p -m 700 /home/bojan/gitchess/apps/server/data/backup
sqlite3 /home/bojan/gitchess/apps/server/data/hub.sqlite \
  ".backup /home/bojan/gitchess/apps/server/data/backup/hub-$(date +%F).sqlite"
ls -1t /home/bojan/gitchess/apps/server/data/backup/hub-*.sqlite | tail -n +8 | xargs -r rm   # keep 7
```

Nightly cron example: `17 3 * * * <the commands above in a script>`. A second copy outside this host (another machine, encrypted) is advisable: a disk failure takes the backups with it. The backup contains hashed token secrets and lichess usernames, so treat it as personal data (`docs/PRIVACY.md`) and give it the same retention as the live file. This is a documented procedure; no timer is installed on the host yet (owner to confirm when it is set up). If `sqlite3` is missing: `sudo apt install sqlite3`.

### Restore

```bash
sudo systemctl stop daisychess-server
cd /home/bojan/gitchess/apps/server/data
mv hub.sqlite hub.sqlite.broken; rm -f hub.sqlite-wal hub.sqlite-shm
cp backup/hub-<date>.sqlite hub.sqlite
sudo systemctl start daisychess-server
curl -s http://127.0.0.1:8580/health/detail
```

Changes since the backup are lost: tokens created later stop working (their holders must be issued new ones), nodes created later must be re-created. Schema migrations are forward-only: restoring a file written by a newer hub into an older server is not supported.

### Rollback to the plain server

Set `ROLE=standalone` (or remove the line) in `.env.production` and `sudo systemctl restart daisychess-server`. `/ws`, rooms and the review store work as before, `ACCESS_TOKEN` (if still set) is the only credential, `/link` and `/api/portal/` answer 404/400 and nodes retry with backoff. `hub.sqlite` is left untouched and is picked up again when `ROLE=hub` returns. nginx and the portal files can stay.

### Retention and logs

| What                                                    | Where                                                                                      | Retention                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application log                                         | journald namespace `daisychess` (`journalctl --namespace=daisychess -u daisychess-server`) | at `info` no raw IPs (daily-salted `ipHash`), no tokens or FENs. Retention 7 days: `MaxRetentionSec=7day` in `/etc/systemd/journald@daisychess.conf` (from `deploy/journald@daisychess.conf`, M28-6); check with `journalctl --namespace=daisychess --disk-usage` |
| nginx access log (raw IPs, no query strings, no bodies) | `/var/log/nginx/{play,hub}.daisychess.org.access.log`                                      | stock `/etc/logrotate.d/nginx`: daily, 14 days (see "Abuse logging")                                                                                                                                                                                              |
| `usage_daily` (per token and node and day, no IPs)      | `hub.sqlite`                                                                               | `USAGE_RETENTION_DAYS`, default 90                                                                                                                                                                                                                                |
| Spot-check rows                                         | `hub.sqlite`                                                                               | 24 hours                                                                                                                                                                                                                                                          |
| Portal sessions                                         | `hub.sqlite`                                                                               | 30 days or until logout                                                                                                                                                                                                                                           |

### Troubleshooting

- Portal login fails with a network error: check the egress proxy (`curl` above) and `PORTAL_LICHESS_PROXY`.
- Node shows `replaced` or exits: the same token runs twice; rotate it.
- Everything is `node_offline`: `journalctl --namespace=daisychess -u daisychess-server | grep link`, check `limit_conn`/`limit_req` for `/link` in nginx and `fail2ban-client status daisychess-link`.

## Run a community node

A **node** lends the engines of one machine (Stockfish, and Lc0 with the Maia nets) to a DaisyChess
**hub** (ADR-020). It only connects _out_ to the hub over one WebSocket (`HUB_URL`); it opens no
port, needs no TLS certificate and no domain, and works behind NAT. Players reach it through the
hub with the tokens you issue in the operator portal (private node) or through the shared pool.

> **Privacy notice — read before you run a node.** Your node receives the chess positions players
> analyse on it (FEN strings plus search settings) and computes the answers. It does not receive
> player IP addresses, names or account data (the hub keeps those; for pool connections the node
> learns nothing about the player at all, for your own tokens it sees the token's id and label).
> Positions can still be personal — a game in progress, an opening preparation — so do not log
> or keep what passes through the node (the image logs link events, never positions), and only
> join the shared pool if you are comfortable computing for strangers.

### Quickstart (Docker Compose)

Requirements: Docker Engine 24+ with Compose v2.24+, `linux/amd64` or `linux/arm64`
(Raspberry Pi 4/5, Apple Silicon via Docker Desktop, AWS Graviton, Ampere), 1 CPU and 512 MB at
the very least (2+ CPUs and 1 GB recommended).

```bash
git clone https://github.com/refaustria/daisychess && cd daisychess
cp docker/node.env.example docker/.env.node      # git-ignored
$EDITOR docker/.env.node                          # paste NODE_TOKEN from the portal, set limits
docker compose -f docker/docker-compose.node.yml --env-file docker/.env.node up -d
docker compose -f docker/docker-compose.node.yml logs -f node    # "link: registered with the hub"
```

Without a published image (before the first `node-v*` release) build it locally instead: add
`--build` to `up` (~2 min on amd64 with 16 cores; Lc0 compiles from source), or
`--build` with `WITH_MAIA=0` in `.env.node` for an image without Lc0/Maia. Update: `docker compose
… pull && docker compose … up -d` (or `--build` again); the node drains running searches on stop
(`stop_grace_period: 40s`).

Status: `docker compose -f docker/docker-compose.node.yml ps` shows `healthy` once the engine
server is up (the link state is separate — a node waiting for an unreachable hub is still
healthy and retries forever). Details, including the link and engine state:

```bash
docker compose -f docker/docker-compose.node.yml exec node \
  node -e "fetch('http://127.0.0.1:8580/health/detail').then(r=>r.text()).then(console.log)"
```

### Configuration (`docker/.env.node`)

| Variable                                                                    | Default                                     | Meaning                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HUB_URL`                                                                   | `wss://hub.daisychess.org/link`             | Hub link endpoint: the public hub (ADR-021; the image's entrypoint applies this default when unset). `wss://` only; `ws://` to a non-loopback host needs `DAISYCHESS_INSECURE=1` (test setups). |
| `NODE_TOKEN`                                                                | – (required)                                | `dcn_<id>_<secret>` from the portal, shown once. Or `NODE_TOKEN_FILE=/run/secrets/…` (compose secret) so the token is not in the container env.                                                 |
| `NODE_NAME`                                                                 | –                                           | Local name in logs and `/health/detail` (players see the portal name).                                                                                                                          |
| `NODE_POOL`                                                                 | `off`                                       | `on` offers the node to the shared pool (the portal switch must allow it too).                                                                                                                  |
| `MAX_SESSIONS` / `NODE_MAX_SESSIONS`                                        | `2`                                         | Engine processes running at once; the hub never routes more.                                                                                                                                    |
| `MAX_THREADS`, `MAX_HASH_MB`, `MAX_DEPTH`, `MAX_MULTIPV`, `MAX_MOVETIME_MS` | see example                                 | Per-search caps announced to the hub and enforced again by the node.                                                                                                                            |
| `MAIA`, `MAIA_MAX_PROCESSES`                                                | `on`, `2`                                   | Human-like engines; `off` on tiny machines. Automatically `off` in a `WITH_MAIA=0` image.                                                                                                       |
| `NODE_CPUS`, `NODE_MEMORY`                                                  | `2`, `1g`                                   | Compose resource limits (`cpus`, `mem_limit`).                                                                                                                                                  |
| `NODE_IMAGE`                                                                | `ghcr.io/refaustria/daisychess-node:latest` | Image to run; pin a version or digest on unattended hosts.                                                                                                                                      |

Sizing: Stockfish uses up to `MAX_THREADS` cores per search and `MAX_SESSIONS` searches run at
once, so keep `MAX_SESSIONS × MAX_THREADS ≤ NODE_CPUS`; memory needs about
`MAX_SESSIONS × (MAX_HASH_MB + 80 MB) + 200 MB`, plus ~20 MB per Maia process. Lending a
machine you also use: leave a core free and lower `NODE_CPUS`; the container cannot exceed it.

### CPU notes

- **amd64:** the image ships the official Stockfish 19 _universal_ binary (sha256-verified
  release asset), which picks the fastest instruction set at start — x86-64, SSE4.1/POPCNT,
  AVX2, BMI2, AVX-VNNI, AVX-512, VNNI-512, AVX-512 ICL. CPUs **without AVX2** (older or
  virtualised ones, like this project's own host, ADR-003) work, just slower. The container
  logs the detected and the selected variant at start (`daisychess-node: cpu: …`); a VM that
  hides AVX2 from the guest gets the SSE4.1 build, so pass the host CPU through
  (`-cpu host`) if you can. Lc0 is built for a portable SSE4.2 baseline (Maia needs one
  network evaluation per move; speed does not matter).
- **arm64:** Stockfish is compiled in the image from the pinned, checksum-verified sf_19 source
  as `ARCH=arm64-universal` — armv8 (NEON; Raspberry Pi 4, Graviton 1) plus armv8-dotprod
  (Pi 5, Apple M-series, Graviton 2+, Ampere Altra), selected at runtime. Lc0 uses NEON.
  (`--build-arg STOCKFISH_ARM64=release` uses the official arm64 universal asset instead.)
- A suggested start for a Raspberry Pi 4 (4 cores, 4 GB): `MAX_SESSIONS=2 MAX_THREADS=2 MAX_HASH_MB=128` (not measured yet).

### Hardening (what the compose file does)

Non-root user (uid 10001), read-only root filesystem with a 64 MB `/tmp` tmpfs, `cap_drop: ALL`,
`no-new-privileges`, a pid limit, bounded logs, no published ports (the health endpoint listens
on the container's loopback only and is checked from inside), no secrets in the image — the
token arrives at runtime. A fatal link answer (`bad_token`, `revoked`, `node_outdated`,
`replaced` = the same token running twice) makes the node exit non-zero on purpose; Docker's
increasing restart delay keeps it from hammering the hub — fix the token and `up -d` again.

### Smoke test and releases

`scripts/node-image-smoke.sh` builds the image (amd64 by default, `--platform linux/arm64` with
QEMU or on an arm64 host), checks the image metadata, runs it offline (`--network none`: healthy,
engines found, reconnect backoff against an unreachable hub, read-only root, clean SIGTERM),
and then links it to a fake hub (`scripts/node-smoke-hub.mjs`) for one Stockfish search and one
Maia move, plus a 1-CPU `MAIA=off` run. Releases: push a `node-v<x.y.z>` tag;
`.github/workflows/release-node.yml` builds both architectures on native runners, runs the smoke
test on each and pushes `ghcr.io/<owner>/daisychess-node:<x.y.z>`, `:<x.y>` and `:latest`
with provenance and an SBOM.

## Mobile release

`.github/workflows/release-mobile.yml` (ADR-022 §6, M26-8) builds the store versions of
`apps/mobile` (`org.daisychess.app`). Marketing version = `apps/mobile/package.json` `version`
(must equal the tag); build number (Android `versionCode`, iOS `CFBundleVersion`) = the workflow
run number, so it rises with every run, dry runs included.

| Trigger                                         | Android                                                                                                                                           | iOS                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| tag `mobile-v<x.y.z>`                           | signed AAB as artifact `android-aab-<version>-<build>` (30 days); Play **internal** track only when the variable `PLAY_PUBLISH_ENABLED` is `true` | signed IPA as artifact `ios-ipa-…` and upload to **TestFlight** |
| `workflow_dispatch`, `dry_run` = true (default) | AAB, signed when the secrets exist, else unsigned; no upload                                                                                      | archive (+ signed IPA when the secrets exist); no upload        |
| `workflow_dispatch` on a tag, `dry_run` = false | like a tag push (re-release with a new build number)                                                                                              | same                                                            |

A tag run with missing signing inputs fails in its first step, before building, naming what is
missing. Secret values are never printed (GitHub masks them; the scripts print no key material).

### Secrets and variables

| Name                                                              | Kind             | Content                                                              | Set with                                                                       |
| ----------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ANDROID_UPLOAD_KEYSTORE_B64`                                     | secret           | base64 of the upload keystore (PKCS12)                               | `scripts/mobile/new-upload-keystore.sh` prints the command                     |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_PASSWORD` | secret           | the keystore password (PKCS12: both equal)                           | `gh secret set …` (prompts)                                                    |
| `ANDROID_UPLOAD_KEY_ALIAS`                                        | secret           | `daisychess-upload`                                                  | `gh secret set … --body daisychess-upload`                                     |
| `PLAY_SERVICE_ACCOUNT_JSON`                                       | secret           | JSON key of `gitref-play-release@gitref.iam.gserviceaccount.com`     | `gh secret set PLAY_SERVICE_ACCOUNT_JSON < ~/gitref-play-service-account.json` |
| `IOS_DIST_CERT_P12_B64`, `IOS_DIST_CERT_PASSWORD`                 | secret           | Apple Distribution certificate + private key (.p12) and its password | `scripts/mobile/set-ios-secrets.sh --apply <file.p12>`                         |
| `ASC_API_KEY_P8_B64`                                              | secret           | base64 of the App Store Connect team key `AuthKey_<ASC_KEY_ID>.p8`   | set                                                                            |
| `IOS_PROVISIONING_PROFILE_B64`                                    | secret, optional | a manually created App Store profile; overrides the API (see below)  | `set-ios-secrets.sh --apply <p12> <profile>`                                   |
| `APPLE_TEAM_ID` (`PM7LTV7M72`), `ASC_KEY_ID`, `ASC_ISSUER_ID`     | variables        |                                                                      | set                                                                            |
| `PLAY_PUBLISH_ENABLED`                                            | variable         | `true` after the first manual Play upload                            | `gh variable set PLAY_PUBLISH_ENABLED --body true`                             |
| `PLAY_SIGNING_SHA256`                                             | variable         | Play **app signing** certificate SHA-256 (for `assetlinks.json`)     | `gh variable set PLAY_SIGNING_SHA256 --body 'AA:BB:…'`                         |

### How the jobs sign

- **Android**: `app/build.gradle` reads `versionName` from `apps/mobile/package.json`,
  `versionCode` from `DAISYCHESS_VERSION_CODE` (default 1) and signs `bundleRelease` with the upload
  key only when `ANDROID_UPLOAD_KEYSTORE_FILE` (+ the password/alias variables) is set. **Play App
  Signing** stays on: Google re-signs with the app signing key, the upload key only authenticates
  uploads. Publishing is `apps/mobile/scripts/play-publish.mjs` (Android Publisher API v3: edit →
  bundle upload → internal track → commit; it falls back to a `draft` release while the app itself
  is still a draft in Play Console). It replaces the Gradle Play Publisher plugin named in ADR-022:
  four API calls, no Gradle plugin in the committed project.
- **iOS**: the .p12 goes into a temporary keychain; `apps/mobile/scripts/asc-profile.mjs` finds or
  creates the App Store profile `DaisyChess App Store CI` for `org.daisychess.app` containing exactly
  that certificate through the App Store Connect API (reused while active and valid for > 7 days;
  stale ones — expired, invalidated by a capability change, other certificate — are deleted and
  recreated). The job then switches only the App target's Release configuration to manual signing
  (`ios-signing.mjs patch`, in the runner's checkout), archives, exports with method
  `app-store-connect` and uploads with `xcrun altool --upload-app` (API key from `~/private_keys`).
  Keychain, key and profile are deleted in an `always()` step. `ITSAppUsesNonExemptEncryption=false`
  (HTTPS/WSS only) is in `Info.plist`, so TestFlight asks no export-compliance question.
  _Why not `xcodebuild -allowProvisioningUpdates` with the API key:_ automatic signing archives with
  a _development_ identity first and, on a clean runner, creates a new Apple Development certificate
  per run (certificate limit, needs a role that may create certificates; cloud-managed distribution
  certificates need an Admin key). Manual signing with an API-managed profile is deterministic,
  idempotent and needs only profile access. If the App Manager key gets HTTP 403 on
  `/v1/profiles`, the job says so: either give the key access to Certificates, Identifiers &
  Profiles, or create the profile in the developer portal (App Store, `org.daisychess.app`, the
  distribution certificate) and set `IOS_PROVISIONING_PROFILE_B64`.

### Promoting an uploaded build

Play rejects a versionCode twice, so moving a build to another track is not a re-upload: run
`gh workflow run play-promote.yml -f version_code=9 [-f track=production] [-f release_name='0.1.0 (9)'] [-f release_notes_en='First release.']`
(`apps/mobile/scripts/play-promote.mjs`: edit → track update → commit; falls back to a `draft`
release while the app is still a draft). On failure Play's error body is printed; it names missing
declarations (data safety, content rating, ...) to complete in Play Console. The service account
needs the "Release to production" permission for the `production` track.

### Owner checklist (once, in this order)

1. **Android upload key** (on this host; outside the repo):
   `scripts/mobile/new-upload-keystore.sh` (default `~/daisychess-upload.p12`), back up the file and
   the password, then run the four `gh secret set` commands it prints.
2. **Play service account**: `gh secret set PLAY_SERVICE_ACCOUNT_JSON < ~/gitref-play-service-account.json`.
   In Play Console → Users and permissions, invite `gitref-play-release@gitref.iam.gserviceaccount.com`
   for the app DaisyChess with "Release apps to testing tracks" (and "View app information"); the
   Google Play Android Developer API must be enabled in the `gitref` Cloud project (it is for gitref).
3. **iOS certificate**: `scripts/mobile/set-ios-secrets.sh --apply ~/ios-signing/<distribution>.p12`
   (checks the password locally, then sets `IOS_DIST_CERT_P12_B64` and `IOS_DIST_CERT_PASSWORD`).
4. **App Store Connect app record** (needed for TestFlight): Apps → + → New App, iOS, name
   DaisyChess, bundle id `org.daisychess.app`, any SKU (e.g. `daisychess-ios`).
5. **Dry run** (after this workflow is on `main`):
   `gh workflow run release-mobile.yml -f dry_run=true`, then `gh run watch`. Both jobs must be
   green; the iOS log shows `"action":"created"` for the profile, the Android log the upload
   certificate fingerprint.
6. **First Play upload (manual)**: `gh run download <run id> -n android-aab-<version>-<build>` (or
   build locally: `scripts/mobile/build-signed-aab.sh ~/daisychess-upload.p12 1`, see below), then
   Play Console → DaisyChess → Test and release → Testing → Internal testing → Create new release →
   upload the AAB; accept Play App Signing with a Google-generated app signing key.
7. **App Links fingerprint**: Play Console → Test and release → App integrity → App signing → "App
   signing key certificate" SHA-256 → `gh variable set PLAY_SIGNING_SHA256 --body 'AA:BB:…'` and on
   the server `PLAY_SIGNING_SHA256='AA:BB:…' deploy/deploy-web.sh` (renders `assetlinks.json`).
8. `gh variable set PLAY_PUBLISH_ENABLED --body true`.
9. **Release**: see "How to tag".

### First Android upload from this host

```bash
scripts/mobile/build-signed-aab.sh ~/daisychess-upload.p12 1
# = pnpm install --frozen-lockfile && pnpm --filter @daisychess/engine-core build
#   && pnpm --filter @daisychess/mobile build
#   && (cd apps/mobile/android && ANDROID_UPLOAD_KEYSTORE_FILE=… ANDROID_UPLOAD_KEYSTORE_PASSWORD=…
#       ANDROID_UPLOAD_KEY_ALIAS=daisychess-upload ANDROID_UPLOAD_KEY_PASSWORD=…
#       DAISYCHESS_VERSION_CODE=1 ./gradlew --no-daemon bundleRelease)
```

It prompts for the password (hidden) and leaves
`apps/mobile/android/app/build/outputs/bundle/release/app-release.aab` (git-ignored). Play rejects a
`versionCode` it has seen: after a manual upload with code N, the next CI upload needs a run number
greater than N (the dry run of step 5 already makes the first tag run #2 or later).

### How to tag

```bash
# bump apps/mobile/package.json "version" (x.y.z, no pre-release suffix) in a commit on main, then
git tag mobile-v0.1.0 && git push origin mobile-v0.1.0
```

The tag is the GPL "corresponding source" of that store build (ADR-022 §3); never move or delete a
released tag. To rebuild a release (e.g. after a failed upload), run the workflow from the tag with
`dry_run` false; it gets a new build number.

### Rotation

- **Distribution certificate** (expires yearly): create a new Apple Distribution certificate,
  export it with its key as .p12, run `set-ios-secrets.sh --apply` again. The next run notices that
  the profile lacks the new certificate and replaces it. Revoke the old certificate afterwards.
- **App Store Connect key**: create a new team key, `gh variable set ASC_KEY_ID --body <id>`,
  `gh secret set ASC_API_KEY_P8_B64 < <(base64 < AuthKey_<id>.p8 | tr -d '\n')`, revoke the old key.
- **Play service account key**: create a new JSON key in the Cloud console, set
  `PLAY_SERVICE_ACCOUNT_JSON` again, delete the old key.
- **Upload key** lost or leaked: `new-upload-keystore.sh` a new one (it also writes
  `<name>-cert.pem`), request an upload key reset in Play Console → App integrity with that PEM,
  set the four `ANDROID_UPLOAD_*` secrets again after Google confirms. The app signing key (and so
  `PLAY_SIGNING_SHA256`) does not change.

### App Store metadata

`.github/workflows/store-metadata.yml` (manual, `workflow_dispatch`) fills the App Store Connect
record of `org.daisychess.app` from the repo with `apps/mobile/scripts/asc-metadata.mjs` (App Store
Connect API, same team key as the release). It is idempotent: unchanged fields are not written, and
a screenshot set is replaced only when the files differ (name and MD5, in order).

| Input     | Default | Effect                                                                         |
| --------- | ------- | ------------------------------------------------------------------------------ |
| `submit`  | false   | after filling the record, create a review submission and submit it for review  |
| `dry_run` | false   | read the record and print the planned changes (log and job summary), no writes |

What it sets, and where the values come from:

| Field                                                                   | Source                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| version `<apps/mobile/package.json version>` (renames the editable one) | `apps/mobile/package.json`; copyright from `listing.en.json`                                                        |
| description, keywords, promotional text, support and marketing URL      | `apps/mobile/store/listing.en.json` (`apple`, URLs)                                                                 |
| name, subtitle, privacy policy URL                                      | same                                                                                                                |
| categories, content rights, age rating answers, availability, price     | `apps/mobile/store/app-store.json`                                                                                  |
| App Review contact (name, e-mail; phone), notes, no demo account        | `app-store.json`, variable `REVIEW_CONTACT_PHONE`, secret `REVIEW_TOKEN`, notes from `apps/site/STORE_CHECKLIST.md` |
| custom EULA (all territories)                                           | `apps/site/STORE_CHECKLIST.md`                                                                                      |
| screenshots `APP_IPHONE_67` (6.9"), `APP_IPAD_PRO_3GEN_129` (13")       | `apps/mobile/store/screenshots/{iphone-6.9,ipad-13}/*.png`                                                          |
| build                                                                   | newest processed TestFlight build of that version                                                                   |

Extra inputs: secret `REVIEW_TOKEN` (a revocable reviewer token minted in the portal; the review
notes quote it; without it the notes are left as they are and `submit` refuses to run) and variable
`REVIEW_CONTACT_PHONE` (international format; App Review requires a phone). Both are optional for a
fill-only run; without the phone the review details are not created at all (App Store Connect
refuses them). Overrides for a local run: `REVIEW_CONTACT_FIRST_NAME`, `REVIEW_CONTACT_LAST_NAME`,
`REVIEW_CONTACT_EMAIL`.

```bash
gh workflow run store-metadata.yml -f submit=false   # fill the record (no review submission)
gh workflow run store-metadata.yml -f dry_run=true   # plan only
gh workflow run store-metadata.yml -f submit=true    # fill and submit for App Review
# local: ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=AuthKey_….p8 node apps/mobile/scripts/asc-metadata.mjs --dry-run
```

Not possible through the API (checked against the App Store Connect OpenAPI spec 4.5.1); every run
prints these as "owner steps" at the end of the log and in the job summary:

- **App Privacy** questionnaire (answers on https://daisychess.org/app-privacy/), then "Publish".
- **Digital Services Act trader status** (EU).
- Price and availability when the key's role gets HTTP 403 for them (the run then warns instead of
  failing).
- `availableInNewTerritories` on an existing availability record (the API has no update for it).

Other locales: App Store Connect auto-creates an empty localization of the app's primary language
when the app is created, which blocks App Review (HTTP 409 on the submission). The script switches
the app's primary locale to `locale` (en-US), deletes empty version-localization stubs of other
locales and warns about ones with content (complete or delete them by hand).

Decisions encoded in `app-store.json` that the owner should know: primary category Games › Board,
secondary Education; content rights "uses third-party content" (lichess puzzle database, lichess
and chess.com APIs); China mainland excluded (needs an ICP filing and a game approval number).

### Troubleshooting

- `play-publish: … HTTP 403/404` — the package has had no manual upload yet or the service account
  lacks app permissions; keep `PLAY_PUBLISH_ENABLED` unset and upload the artifact by hand.
- `asc-profile: … not (or no longer) registered` — the .p12 certificate was revoked or expired.
- "Export IPA" fails or reports no `com.apple.developer.associated-domains` — the App Store profile
  was created before the Associated Domains capability was enabled on the App ID. Enable it
  (Certificates, Identifiers & Profiles → Identifiers → `org.daisychess.app`) and rerun:
  `asc-profile.mjs` compares the profile's entitlements with `App.entitlements` and logs
  `"action":"recreated","reason":"missing-entitlements"` after replacing it. With
  `IOS_PROVISIONING_PROFILE_B64` set the profile is not managed: regenerate it by hand.
- `altool` "bundle version must be higher" — a build with that number exists; rerun (new run number).
- `asc-metadata: … HTTP 409` — App Store Connect rejected a value; the log lists its error codes and
  JSON pointers. `App Store version … is in state WAITING_FOR_REVIEW` — already submitted; nothing
  to do until App Review decides (or the submission is cancelled in App Store Connect).
