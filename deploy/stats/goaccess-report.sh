#!/usr/bin/env bash
# Generates the static GoAccess traffic reports served (basic auth) at https://daisychess.org/stats/.
# Runs hourly from daisychess-stats.timer as the system user daisychess-stats (group adm reads the
# 0640 www-data:adm nginx logs). No GoAccess database is kept (no --persist/--restore), so a report
# never holds more than the 14 days of rotated logs. See deploy/README.md "Traffic stats".
#
# Usage: goaccess-report.sh [LOG_DIR [OUT_DIR]]   (defaults: /var/log/nginx, /var/www/daisychess-stats)
set -euo pipefail

LOG_DIR="${1:-/var/log/nginx}"
OUT_DIR="${2:-/var/www/daisychess-stats}"

# nginx log_format `daisychess` (deploy/nginx/daisychess-common.conf):
#   1.2.3.4 [30/Oct/2026:00:31:40 +0100] "GET /index.html HTTP/1.1" 200 5438 rt=0.000 urt=- origin="-" ua="…"
# %h host, %d:%t date:time (%^] skips the zone), %m %U %H request, %s status, %b bytes, %T request
# time (rt=), %^ skips urt= ("-" or "0.010, 0.002" after a retry), %R puts the Origin header in the
# referrer slot (panel "Referring sites": capacitor://app.daisychess.org = iOS app,
# https://app.daisychess.org = Android app, https://play.daisychess.org = web), %u user agent.
LOG_FORMAT='%h [%d:%t %^] "%m %U %H" %s %b rt=%T urt=%^ origin="%R" ua="%u"'
DATE_FORMAT='%d/%b/%Y'
TIME_FORMAT='%H:%M:%S'

# site -> "title|description"
SITES=(
  "daisychess.org|Website visitors"
  "play.daisychess.org|Web app and API"
  "hub.daisychess.org|Hub: apps and community nodes"
)

mkdir -p "$OUT_DIR"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

# All available logs of one site, oldest first is not required (GoAccess sorts by timestamp).
emit_logs() {
  local site="$1" f
  for f in "$LOG_DIR/$site.access.log" "$LOG_DIR/$site.access.log".*; do
    [ -f "$f" ] || continue
    case "$f" in
      *.gz) zcat -- "$f" ;;
      *) cat -- "$f" ;;
    esac
  done
}

generated="$(date '+%Y-%m-%d %H:%M %Z')"
links=""

for entry in "${SITES[@]}"; do
  site="${entry%%|*}"
  desc="${entry#*|}"
  out="$tmp_dir/$site.html"
  # `|| true`: an unreadable/rotated-away file between the glob and the read must not abort the run.
  emit_logs "$site" >"$tmp_dir/$site.log" 2>/dev/null || true
  if [ ! -s "$tmp_dir/$site.log" ]; then
    echo "no logs for $site, skipping" >&2
    continue
  fi
  # Reports embed their own JS/CSS (no external resources). --no-query-string: the logs hold none
  # anyway. --no-progress/--no-global-config keep the run quiet and independent of /etc/goaccess.
  goaccess "$tmp_dir/$site.log" \
    --log-format="$LOG_FORMAT" --date-format="$DATE_FORMAT" --time-format="$TIME_FORMAT" \
    --ignore-crawlers --real-os --no-query-string --no-progress --no-global-config \
    --html-report-title="DaisyChess stats - $site" \
    -o "$out"
  chmod 0644 "$out"
  mv -f "$out" "$OUT_DIR/$site.html"
  rm -f "$tmp_dir/$site.log"
  links+="      <li><a href=\"$site.html\">$site</a> - $desc</li>"$'\n'
done

cat >"$tmp_dir/index.html" <<HTML
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>DaisyChess stats</title>
  <style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}</style>
</head>
<body>
  <h1>DaisyChess stats</h1>
  <ul>
${links}  </ul>
  <p>Generated $generated from the last 14 days of access logs.</p>
</body>
</html>
HTML
chmod 0644 "$tmp_dir/index.html"
mv -f "$tmp_dir/index.html" "$OUT_DIR/index.html"
