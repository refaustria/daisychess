#!/usr/bin/env bash
# Build apps/web and publish it to the nginx web root for https://c.referee.at.
# Usage: deploy/deploy-web.sh   (from anywhere inside the repo)
set -euo pipefail

WEB_ROOT="${WEB_ROOT:-/var/www/c.referee.at}"
SITE_URL="${SITE_URL:-https://c.referee.at/}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

pnpm install --frozen-lockfile
pnpm --filter @chesslab/web build

if [[ ! -f apps/web/dist/index.html ]]; then
  echo "error: apps/web/dist/index.html missing after build" >&2
  exit 1
fi

rsync -a --delete apps/web/dist/ "$WEB_ROOT"/

echo "Deployed to ${SITE_URL}"
