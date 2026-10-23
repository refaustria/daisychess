# Deployment: https://c.referee.at

Single host (Debian 13), nginx + Let's Encrypt (certbot nginx plugin). See
`docs/DECISIONS.md` ADR-001 (ports) and ADR-002 (hosting model).

| What | Where |
|---|---|
| Static web build | `/var/www/c.referee.at` (owner `bojan:bojan`) |
| nginx site | `/etc/nginx/sites-available/c.referee.at` → symlink in `sites-enabled/` |
| Repo copy (pre-certbot) | `deploy/nginx/c.referee.at.conf` |
| TLS cert | `/etc/letsencrypt/live/c.referee.at/` |
| Engine server | `127.0.0.1:8580`, proxied at `/ws` and `/health` |
| Server unit | `deploy/chesslab-server.service` (installed by `deploy/deploy-server.sh`) |

The site sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (multi-threaded WASM), plus CORP,
nosniff and Referrer-Policy. `/assets/*` is cached immutably, `index.html` is
`no-cache`, unknown paths fall back to `index.html` (SPA). No HSTS.

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

Runs `pnpm install --frozen-lockfile`, `pnpm --filter @chesslab/web build`,
then `rsync -a --delete apps/web/dist/ /var/www/c.referee.at/`. No nginx reload
needed.

## Engine server

Systemd unit `chesslab-server` (user `bojan`, `127.0.0.1:8580`), deployed on 2026-10-23.

```bash
deploy/deploy-server.sh
```

Runs `pnpm install --frozen-lockfile`, builds `engine-core` and `server`, runs
`pnpm fetch-engines` (idempotent), installs `deploy/chesslab-server.service` to
`/etc/systemd/system/`, `daemon-reload`, `enable` + `restart`, then waits up to
10 s for `http://127.0.0.1:8580/health` and prints it. Needs `sudo`.

Verify:

```bash
systemctl status chesslab-server
curl -s https://c.referee.at/health
node deploy/ws-smoke.mjs            # hello -> analyze depth 12 -> bestmove (Node 22+)
```

**Limits and config.** The server does not read `.env` itself; the unit loads
`apps/server/.env.production` via `EnvironmentFile=-` (optional file, not
created by the script; copy from `apps/server/.env.example`; currently
`MAX_SESSIONS=4`, `MAX_THREADS=4`, `LOG_LEVEL=info`). Edit it, then
`sudo systemctl restart chesslab-server`. Per-engine defaults and
`maxInstances` live in `apps/server/engines.json`. Resource caps (`MemoryMax`,
`CPUWeight`, `TasksMax`) are in the unit; after editing it, rerun the script.
The unit is read-only on the filesystem (`ProtectSystem=strict`,
`ProtectHome=read-only`); add `ReadWritePaths=` if the server ever writes.

**Logs.** JSON lines in the journal (your user needs group `adm` or
`systemd-journal`, otherwise use `sudo`):

```bash
sudo journalctl -u chesslab-server -n 50 --no-pager
sudo journalctl -u chesslab-server -f
```

`/health` requests are not logged by the server, so polling it adds no noise.

**Roll back.**

```bash
git checkout <previous-commit>   # or: git stash / git switch
deploy/deploy-server.sh
```

Stopping the service kills the whole cgroup (`KillMode=control-group`), so no
orphaned `stockfish` processes remain.

**nginx.** `/ws` has `limit_conn chesslab_ws 10` (per IP, excess gets 429); the
`limit_conn_zone` line sits at the top of the site file (http context). It was
merged by hand into the live certbot-managed file.

## Certificate renewal

Handled automatically by certbot's systemd timer (`certbot.timer`). Check with:

```bash
systemctl list-timers certbot.timer
sudo certbot certificates
sudo certbot renew --dry-run --cert-name c.referee.at
```
