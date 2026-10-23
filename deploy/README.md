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
| Server unit (template) | `deploy/chesslab-server.service` |

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

## Engine server (later)

```bash
pnpm --filter @chesslab/server build        # produces apps/server/dist/index.js
sudo cp deploy/chesslab-server.service /etc/systemd/system/chesslab-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now chesslab-server
systemctl status chesslab-server
journalctl -u chesslab-server -f
curl -s https://c.referee.at/health
```

Until the service runs, `/ws` and `/health` return 502 (expected). The unit
uses `ProtectSystem=strict` and `ProtectHome=read-only`; if the server needs to
write anywhere, add the path to `ReadWritePaths=`. After code updates:
rebuild, then `sudo systemctl restart chesslab-server`.

## Certificate renewal

Handled automatically by certbot's systemd timer (`certbot.timer`). Check with:

```bash
systemctl list-timers certbot.timer
sudo certbot certificates
sudo certbot renew --dry-run --cert-name c.referee.at
```
