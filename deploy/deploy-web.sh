#!/usr/bin/env bash
# Build apps/web and publish it to the nginx web root for https://play.daisychess.org
# (ADR-021; the legacy c.referee.at serves only the "moved" page, see deploy/deploy-legacy.sh).
# Usage: deploy/deploy-web.sh   (from anywhere inside the repo)
set -euo pipefail

WEB_ROOT="${WEB_ROOT:-/var/www/play.daisychess.org}"
SITE_URL="${SITE_URL:-https://play.daisychess.org/}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

pnpm install --frozen-lockfile
pnpm --filter @daisychess/web build

if [[ ! -f apps/web/dist/index.html ]]; then
  echo "error: apps/web/dist/index.html missing after build" >&2
  exit 1
fi

# /portal/ belongs to deploy/deploy-portal.sh: keep it out of this --delete.
rsync -a --delete --exclude /portal/ apps/web/dist/ "$WEB_ROOT"/

echo "Deployed to ${SITE_URL}"
