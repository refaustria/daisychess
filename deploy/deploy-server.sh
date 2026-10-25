#!/usr/bin/env bash
# Build and (re)deploy the DaisyChess engine server as the systemd unit daisychess-server.
# Usage: deploy/deploy-server.sh   (from anywhere inside the repo; needs sudo)
set -euo pipefail

# /health/detail (pool stats) is only served on the loopback listener; nginx proxies /health alone.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8580/health/detail}"
UNIT=daisychess-server
# Unit name before the rename (ADR-018); replaced by $UNIT on the first deploy after it.
LEGACY_UNIT=chesslab-server

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

pnpm install --frozen-lockfile
pnpm --filter @daisychess/engine-core build
pnpm --filter @daisychess/server build
pnpm fetch-engines   # Stockfish + the Maia nets (idempotent, checksum-verified)
pnpm build-lc0       # Lc0 for the Maia nets (ADR-019); skipped when the pinned build is present

if [[ ! -f apps/server/dist/index.js ]]; then
  echo "error: apps/server/dist/index.js missing after build" >&2
  exit 1
fi

# Rename (ADR-018): stop, disable and remove the old unit first so it cannot hold port 8580.
if [[ -f "/etc/systemd/system/${LEGACY_UNIT}.service" ]] || systemctl list-unit-files "${LEGACY_UNIT}.service" --no-legend 2>/dev/null | grep -q .; then
  echo "Replacing legacy unit ${LEGACY_UNIT} with ${UNIT}"
  sudo systemctl stop "$LEGACY_UNIT" || true
  sudo systemctl disable "$LEGACY_UNIT" || true
  sudo rm -f "/etc/systemd/system/${LEGACY_UNIT}.service"
  sudo systemctl daemon-reload
  sudo systemctl reset-failed "$LEGACY_UNIT" 2>/dev/null || true
fi

# ReadWritePaths needs the directory to exist before the unit's namespace is set up (ADR-017).
install -d -m 700 apps/server/data
sudo install -m 644 deploy/daisychess-server.service "/etc/systemd/system/${UNIT}.service"
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
