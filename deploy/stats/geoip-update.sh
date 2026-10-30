#!/usr/bin/env bash
# Downloads the free DB-IP "IP to Country Lite" database (CC BY 4.0, https://db-ip.com) used by the
# traffic stats for the country lookup. Tries the current month, falls back to the previous one (the
# file for a new month appears a few days late). Runs monthly from daisychess-geoip.timer.
#
# Usage: geoip-update.sh [DEST_FILE]   (default /var/lib/daisychess-stats/dbip-country-lite.mmdb)
set -euo pipefail

DEST="${1:-/var/lib/daisychess-stats/dbip-country-lite.mmdb}"
BASE_URL="${DBIP_BASE_URL:-https://download.db-ip.com/free}"
MIN_BYTES=1000000   # the decompressed file is ~5 MB; anything below 1 MB is an error page or truncated

dest_dir="$(dirname "$DEST")"
mkdir -p "$dest_dir"
tmp_dir="$(mktemp -d "$dest_dir/.geoip.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

current="$(date -u +%Y-%m)"
previous="$(date -u -d "$(date -u +%Y-%m-15) -1 month" +%Y-%m)"

got=""
for month in "$current" "$previous"; do
  url="$BASE_URL/dbip-country-lite-$month.mmdb.gz"
  if curl -fsSL --proto '=https' --max-time 300 -o "$tmp_dir/db.gz" "$url"; then
    got="$month"
    break
  fi
  echo "no download for $month ($url)" >&2
done
[ -n "$got" ] || { echo "geoip-update: no database available" >&2; exit 1; }

gzip -t "$tmp_dir/db.gz" || { echo "geoip-update: not a valid gzip file" >&2; exit 1; }
gzip -dc "$tmp_dir/db.gz" >"$tmp_dir/db.mmdb"
size="$(stat -c %s "$tmp_dir/db.mmdb")"
[ "$size" -ge "$MIN_BYTES" ] || { echo "geoip-update: database too small ($size bytes)" >&2; exit 1; }

chmod 0644 "$tmp_dir/db.mmdb"
mv -f "$tmp_dir/db.mmdb" "$DEST"   # same filesystem: atomic replace
echo "geoip-update: installed dbip-country-lite-$got ($size bytes) at $DEST"
