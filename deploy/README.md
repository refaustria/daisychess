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
then `rsync -a --delete --exclude /portal/ apps/web/dist/ /var/www/play.daisychess.org/`. No nginx reload
needed.
The build includes the opt-in full-strength Stockfish build
(`assets/engine/stockfish-<version>/stockfish-19.wasm`, ~99 MB; ADR-010), so `dist/`
is ~105 MB; browsers fetch it only when a user enables "maximum strength".

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
`ALLOWED_ORIGINS=https://play.daisychess.org` (ADR-008: browser origins allowed on `/ws`;
other origins get 403 at the upgrade). Edit it, then
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
sudo journalctl -u daisychess-server -n 50 --no-pager
sudo journalctl -u daisychess-server -f
```

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
   ALLOWED_ORIGINS=https://play.daisychess.org
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

| What                                                    | Where                                                 | Retention                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application log                                         | journald (`journalctl -u daisychess-server`)          | at `info` no raw IPs (daily-salted `ipHash`), no tokens or FENs. Retention is the host's journald setting; ADR-020 asks for 7 days (`MaxRetentionSec=7day`), **not configured by the repo: check `journalctl --disk-usage` and `/etc/systemd/journald.conf`** |
| nginx access log (raw IPs, no query strings, no bodies) | `/var/log/nginx/{play,hub}.daisychess.org.access.log` | stock `/etc/logrotate.d/nginx`: daily, 14 days (see "Abuse logging")                                                                                                                                                                                          |
| `usage_daily` (per token and node and day, no IPs)      | `hub.sqlite`                                          | `USAGE_RETENTION_DAYS`, default 90                                                                                                                                                                                                                            |
| Spot-check rows                                         | `hub.sqlite`                                          | 24 hours                                                                                                                                                                                                                                                      |
| Portal sessions                                         | `hub.sqlite`                                          | 30 days or until logout                                                                                                                                                                                                                                       |

### Troubleshooting

- Portal login fails with a network error: check the egress proxy (`curl` above) and `PORTAL_LICHESS_PROXY`.
- Node shows `replaced` or exits: the same token runs twice; rotate it.
- Everything is `node_offline`: `journalctl -u daisychess-server | grep link`, check `limit_conn`/`limit_req` for `/link` in nginx and `fail2ban-client status daisychess-link`.

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
