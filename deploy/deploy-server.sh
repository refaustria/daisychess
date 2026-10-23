#!/usr/bin/env bash
# Build and (re)deploy the ChessLab engine server as the systemd unit chesslab-server.
# Usage: deploy/deploy-server.sh   (from anywhere inside the repo; needs sudo)
set -euo pipefail

# /health/detail (pool stats) is only served on the loopback listener; nginx proxies /health alone.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8580/health/detail}"
UNIT=chesslab-server

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

pnpm install --frozen-lockfile
pnpm --filter @chesslab/engine-core build
pnpm --filter @chesslab/server build
pnpm fetch-engines

if [[ ! -f apps/server/dist/index.js ]]; then
  echo "error: apps/server/dist/index.js missing after build" >&2
  exit 1
fi

sudo install -m 644 deploy/chesslab-server.service "/etc/systemd/system/${UNIT}.service"
sudo systemctl daemon-reload
sudo systemctl enable "$UNIT"
sudo systemctl restart "$UNIT"

for _ in $(seq 1 20); do
  if body="$(curl -fs "$HEALTH_URL")"; then
    echo "$body"
    echo "Deployed ${UNIT}"
    exit 0
  fi
  sleep 0.5
done

echo "error: ${HEALTH_URL} not healthy after 10 s" >&2
sudo journalctl -u "$UNIT" -n 30 --no-pager >&2 || true
exit 1
