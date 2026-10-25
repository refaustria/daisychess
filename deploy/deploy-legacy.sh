#!/usr/bin/env bash
# Publish the legacy c.referee.at "moved" page (apps/web/legacy/, ADR-021) to its nginx root.
# The page hands this origin's localStorage over to https://play.daisychess.org (#migrate=…).
# No build step: the files are served as they are. Leaves /var/www/c.referee.at (the last app
# build, whose /assets/ stay reachable for still-open tabs until the sunset) alone.
# Usage: deploy/deploy-legacy.sh   (from anywhere inside the repo)
set -euo pipefail

LEGACY_ROOT="${LEGACY_ROOT:-/var/www/c.referee.at-legacy}"
SITE_URL="${SITE_URL:-https://c.referee.at/}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/apps/web/legacy"

for f in index.html moved.js migrate-core.js moved.css; do
  if [[ ! -f "$SRC/$f" ]]; then
    echo "error: $SRC/$f missing" >&2
    exit 1
  fi
done

mkdir -p "$LEGACY_ROOT"
# Only the four page files (no tests, no .d.ts).
rsync -a --delete --include=index.html --include=moved.js --include=migrate-core.js \
  --include=moved.css --exclude='*' "$SRC"/ "$LEGACY_ROOT"/

echo "Deployed to ${SITE_URL}"
