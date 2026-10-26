#!/usr/bin/env bash
# Build apps/web and publish it to the nginx web root for https://play.daisychess.org
# (ADR-021).
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

# /portal/ belongs to deploy/deploy-portal.sh and /puzzles/ to deploy/deploy-puzzles.sh (ADR-023):
# keep both out of this --delete. assetlinks.json is generated below (not part of the build), so
# keep an already deployed one.
rsync -a --delete --exclude /portal/ --exclude /puzzles/ --exclude /.well-known/assetlinks.json \
  apps/web/dist/ "$WEB_ROOT"/

# Android App Links (ADR-022 §4): /.well-known/assetlinks.json names the Play *app signing*
# certificate (Play Console -> Setup -> App signing -> SHA-256 certificate fingerprint). It is
# written only when PLAY_SIGNING_SHA256 is set (one or more fingerprints, comma-separated, as
# `AA:BB:...`); without it an already deployed file stays and none is created, because a
# placeholder file would make Android silently fail the App Link verification.
if [[ -n "${PLAY_SIGNING_SHA256:-}" ]]; then
  fingerprints=""
  IFS=',' read -ra parts <<<"$PLAY_SIGNING_SHA256"
  for fp in "${parts[@]}"; do
    fp="${fp//[[:space:]]/}"
    if [[ ! "$fp" =~ ^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$ ]]; then
      echo "error: PLAY_SIGNING_SHA256 entry is not a SHA-256 fingerprint (32 colon-separated hex bytes)" >&2
      exit 1
    fi
    fp="${fp^^}"
    fingerprints+="${fingerprints:+, }\"$fp\""
  done
  mkdir -p "$WEB_ROOT/.well-known"
  sed "s#\"<PLAY_SIGNING_SHA256>\"#${fingerprints}#" deploy/assetlinks.json.template \
    >"$WEB_ROOT/.well-known/assetlinks.json"
  echo "Wrote $WEB_ROOT/.well-known/assetlinks.json"
else
  echo "PLAY_SIGNING_SHA256 not set: assetlinks.json left as it is (Android App Links unverified until set)"
fi

echo "Deployed to ${SITE_URL}"
