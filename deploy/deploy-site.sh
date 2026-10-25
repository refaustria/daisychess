#!/usr/bin/env bash
# Build apps/site and publish it to the nginx web root of https://daisychess.org
# (vhost: deploy/nginx/daisychess.org.conf).
# Usage: deploy/deploy-site.sh   (from anywhere inside the repo; needs write access to SITE_ROOT)
set -euo pipefail

SITE_ROOT="${SITE_ROOT:-/var/www/daisychess.org}"
SITE_URL="${SITE_URL:-https://daisychess.org/}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

pnpm install --frozen-lockfile
# The vhost must carry the headers the site was tested with.
node scripts/check-site-csp.mjs
pnpm --filter @daisychess/site build

for f in index.html 404.html sitemap.xml robots.txt og.png features/index.html privacy/index.html; do
  if [[ ! -f "apps/site/dist/$f" ]]; then
    echo "error: apps/site/dist/$f missing after build" >&2
    exit 1
  fi
done

# Two passes so a visitor never gets HTML that points at assets that are not there yet:
# 1) new hashed assets and static files first (nothing deleted), 2) HTML and cleanup.
rsync -a --exclude '*.html' apps/site/dist/ "$SITE_ROOT"/
# --delete keeps .well-known/ (ACME webroot challenges) out of the cleanup.
rsync -a --delete --exclude /.well-known/ apps/site/dist/ "$SITE_ROOT"/

echo "Deployed to ${SITE_URL}"
