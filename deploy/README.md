# Deployment: https://c.referee.at

Single host (Debian 13), nginx + Let's Encrypt (certbot nginx plugin). See
`docs/DECISIONS.md` ADR-001 (ports), ADR-002 (hosting model) and ADR-008 (security
policies); the threat model and hardening checklist are in `docs/SECURITY.md`.

| What | Where |
|---|---|
| Static web build | `/var/www/c.referee.at` (owner `bojan:bojan`) |
| nginx site | `/etc/nginx/sites-available/c.referee.at` → symlink in `sites-enabled/` |
| Repo copy (pre-certbot) | `deploy/nginx/c.referee.at.conf` |
| TLS cert | `/etc/letsencrypt/live/c.referee.at/` |
| Engine server | `127.0.0.1:8580`, proxied at `/ws` and `/health` (`/health/detail` is loopback-only) |
| Server unit | `deploy/daisychess-server.service` (installed by `deploy/deploy-server.sh`) |

The site sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (multi-threaded WASM), plus CORP,
nosniff, Referrer-Policy, an enforced `Content-Security-Policy` and
`Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, no
preload). `/assets/*` is cached immutably, `index.html` is `no-cache`, unknown
paths fall back to `index.html` (SPA).

## First-time setup (already done on 2026-10-23)

```bash
sudo mkdir -p /var/www/c.referee.at
sudo chown bojan:bojan /var/www/c.referee.at
# placeholder index.html written to /var/www/c.referee.at/

sudo cp deploy/nginx/c.referee.at.conf /etc/nginx/sites-available/c.referee.at
sudo ln -s /etc/nginx/sites-available/c.referee.at /etc/nginx/sites-enabled/c.referee.at
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d c.referee.at --non-interactive --agree-tos --redirect -m bojan@referee.at
sudo nginx -t && sudo systemctl reload nginx
```

Certbot edits the installed file in place (adds `listen 443 ssl`, the
certificate lines and a port-80 redirect server block). If you change
`deploy/nginx/c.referee.at.conf` later, apply the change to the installed file
by hand (keep the `# managed by Certbot` lines), or re-copy it and run
`sudo certbot --nginx -d c.referee.at --reinstall --redirect` to re-inject TLS.
Always `sudo nginx -t` before `sudo systemctl reload nginx`.

## Redeploy the web app

```bash
deploy/deploy-web.sh
```

Runs `pnpm install --frozen-lockfile`, `pnpm --filter @daisychess/web build`,
then `rsync -a --delete apps/web/dist/ /var/www/c.referee.at/`. No nginx reload
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
`deploy/deploy-web.sh` and apply `deploy/nginx/c.referee.at.conf` to the installed
site (new CSP hash of the inline theme script, renamed `log_format`/`limit_*`
zones/CSP map variable, `location = /manifest.webmanifest`), keeping the certbot
lines, then `sudo nginx -t && sudo systemctl reload nginx`;
`node scripts/check-csp.mjs /etc/nginx/sites-available/c.referee.at` verifies the CSP.

Verify:

```bash
systemctl status daisychess-server
curl -s https://c.referee.at/health            # {status, version} only
curl -s http://127.0.0.1:8580/health/detail   # pool stats, sessions, connections (loopback)
node deploy/ws-smoke.mjs            # hello -> analyze depth 12 -> bestmove (Node 22+)
# with ACCESS_TOKEN set: without the token the smoke test fails (restricted welcome, `unauthorized`)
DAISYCHESS_TOKEN="$(sed -n 's/^ACCESS_TOKEN=//p' apps/server/.env.production)" node deploy/ws-smoke.mjs
```

**Limits and config.** The server does not read `.env` itself; the unit loads
`apps/server/.env.production` via `EnvironmentFile=-` (optional file, not
created by the script; copy from `apps/server/.env.example`; currently
`MAX_SESSIONS=4`, `MAX_THREADS=4`, `LOG_LEVEL=info`). The unit itself sets
`ALLOWED_ORIGINS=https://c.referee.at` (ADR-008: browser origins allowed on `/ws`;
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

| Limit | Value | Where | Over the limit |
|---|---|---|---|
| WebSocket connections per IP | 10 | nginx `limit_conn` | 429 |
| Handshakes per IP | 5/s, burst 20 | nginx `limit_req` | 429 |
| Engine sessions, global | 4 | `MAX_SESSIONS` | `no_capacity` |
| Review reads / writes per connection | 20/s / 20 per 4 s | connection rate limits | `rate_limited` |
| Review writes per IP and day | 500 | `REVIEW_PUT_PER_IP_PER_DAY` | `review.stored … quota` |
| Review store on disk | 5 GB | `REVIEW_STORE_MAX_BYTES` | LRU eviction to 90 % |
| Engine sessions per IP (all connections) | 2 | `MAX_SESSIONS_PER_IP` (client IP = `X-Real-IP` from loopback nginx) | `no_capacity` "too many sessions from your address" |
| Sessions per connection | 2 | `MAX_SESSIONS_PER_CONNECTION` | `limit_exceeded` |
| Instances per engine | 3 | `engines.json` `maxInstances` | `no_capacity` |
| Respawn after a crash | 0.5 s doubling to 30 s (±20 %), reset after 60 s up or a completed search; `degraded` after 10 | `ENGINE_CRASH_RESET_MS`, `ENGINE_MAX_CONSECUTIVE_CRASHES` | `no_capacity` "restarting after a crash" |
| `analyze` / all messages | 20/s / 100/s per connection | server | `rate_limited` / close 1008 |

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
excess gets 429. The two `*_zone` lines, the `$daisychess_csp` map and the
`daisychess` log format sit at the top of the site file (http context).
`deploy/nginx/c.referee.at.conf` is the source; the live file additionally has
the certbot lines. Apply a change by merging it into the live file, then
`sudo nginx -t && sudo systemctl reload nginx` (back the live file up first:
`sudo cp -a /etc/nginx/sites-available/c.referee.at{,.bak-$(date +%Y%m%d-%H%M%S)}`).

**Content-Security-Policy.** Built by `apps/web/csp.config.mjs` (policy and
rationale: `docs/SECURITY.md` §2.8). The nginx copy contains the sha256 of the
inline theme script in `apps/web/index.html`; if that script changes, the
browser blocks it until nginx is updated. Check repo and live file with

```bash
node scripts/check-csp.mjs /etc/nginx/sites-available/c.referee.at
```

which prints the expected `default "…";` line on a mismatch (CI runs it for
the repo files). Deploy the web build and the nginx change together. To
debug a suspected CSP problem, temporarily rename the header to
`Content-Security-Policy-Report-Only` in all three places (violations then only
show in the browser console) and keep `add_header Content-Security-Policy
"frame-ancestors 'none'" always;` next to it, since `frame-ancestors` is
ignored in report-only mode.

**HSTS.** One year, this host only. Browsers cache it: going back to plain
HTTP needs `max-age=0` served over HTTPS for a while first.

## Abuse logging and fail2ban

nginx writes `/var/log/nginx/c.referee.at.access.log` (and `.error.log`) in the
`daisychess` format: address, time, method, path **without query string**,
status, bytes, `rt=` request time, `urt=` upstream time, `Origin`, User-Agent.
No bodies. The stock `/etc/logrotate.d/nginx` rotates it (daily, 14 days).

```bash
# refused WebSocket upgrades per address (403 = foreign Origin, 429 = nginx limits)
sudo awk '$5 ~ /^\/ws/ && ($7 == 403 || $7 == 429) {print $7, $1}' \
  /var/log/nginx/c.referee.at.access.log | sort | uniq -c | sort -rn | head
```

Engine-level refusals (`rate_limited`, `no_capacity`, `limit_exceeded`) happen
inside an accepted socket and are only in the server journal.

`deploy/fail2ban/` has a filter (403/429 on `/ws`) and a jail (30 within 60 s
→ 10 min ban). fail2ban is **not installed** on this host (2026-10-23), so the
files are inactive. To enable:

```bash
sudo apt install fail2ban
sudo cp deploy/fail2ban/filter.d/daisychess-ws.conf /etc/fail2ban/filter.d/
sudo cp deploy/fail2ban/jail.d/daisychess-ws.conf /etc/fail2ban/jail.d/
sudo fail2ban-regex /var/log/nginx/c.referee.at.access.log daisychess-ws   # dry run
sudo systemctl restart fail2ban && sudo fail2ban-client status daisychess-ws
```

## Certificate renewal

Handled automatically by certbot's systemd timer (`certbot.timer`). Check with:

```bash
systemctl list-timers certbot.timer
sudo certbot certificates
sudo certbot renew --dry-run --cert-name c.referee.at
```
