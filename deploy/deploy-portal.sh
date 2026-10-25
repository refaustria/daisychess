#!/usr/bin/env bash
# Build apps/portal (the operator portal, base /portal/) and publish it to the nginx web root of
# https://play.daisychess.org under /portal/. Does not touch the main app (deploy/deploy-web.sh excludes
# /portal/ from its --delete).
# Usage: deploy/deploy-portal.sh   (from anywhere inside the repo)
# Optional: VITE_HUB_URL=wss://hub.example/link  (HUB_URL shown in the node setup snippets;
# default: wss://hub.daisychess.org/link on play.daisychess.org, else derived from the page
# origin, wss://<host>/link; see apps/portal/src/format.ts).
set -euo pipefail

WEB_ROOT="${WEB_ROOT:-/var/www/play.daisychess.org}"
SITE_URL="${SITE_URL:-https://play.daisychess.org/portal/}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

pnpm install --frozen-lockfile
pnpm --filter @daisychess/portal build

if [[ ! -f apps/portal/dist/index.html ]]; then
  echo "error: apps/portal/dist/index.html missing after build" >&2
  exit 1
fi

mkdir -p "$WEB_ROOT/portal"
rsync -a --delete apps/portal/dist/ "$WEB_ROOT/portal"/

echo "Deployed to ${SITE_URL}"
