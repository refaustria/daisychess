#!/usr/bin/env bash
# iOS simulator smoke (CI job `mobile`, ADR-022): boots a simulator, installs the unsigned
# simulator build, launches the app with its stdout on a pty (Capacitor prints the JS console
# there) and waits for the DAISYCHESS_SMOKE line, then asserts it with check-smoke-log.mjs.
# Usage: ios-smoke.sh <App.app> <out dir> [timeout seconds]
set -euo pipefail
APP=$1
OUT=$2
TIMEOUT=${3:-300}
APP_ID=org.daisychess.app
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"

# Newest available iPhone simulator.
UDID=$(xcrun simctl list devices available -j | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8")).devices;
  const ios = Object.keys(d).filter((k) => k.includes("iOS")).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }));
  for (const rt of ios.reverse()) {
    const phone = d[rt].find((x) => x.isAvailable && /^iPhone/.test(x.name));
    if (phone) { console.log(phone.udid); process.exit(0); }
  }
  process.exit(1);
')
echo "simulator: $UDID"
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$APP"

xcrun simctl launch --console-pty --terminate-running-process "$UDID" "$APP_ID" > "$OUT/app-stdout.txt" 2>&1 &
LAUNCH_PID=$!
deadline=$((SECONDS + TIMEOUT))
found=0
while ((SECONDS < deadline)); do
  if grep -q 'DAISYCHESS_SMOKE {' "$OUT/app-stdout.txt"; then
    found=1
    break
  fi
  sleep 3
done
sleep 1
xcrun simctl io "$UDID" screenshot "$OUT/screen.png" || true
xcrun simctl terminate "$UDID" "$APP_ID" || true
kill "$LAUNCH_PID" 2>/dev/null || true
wait "$LAUNCH_PID" 2>/dev/null || true
xcrun simctl spawn "$UDID" log show --last 10m --style compact \
  --predicate 'process == "App" OR subsystem == "com.apple.WebKit"' > "$OUT/oslog.txt" 2>&1 || true
((found)) || echo "no smoke result within ${TIMEOUT}s" >&2
node "$HERE/check-smoke-log.mjs" "$OUT/app-stdout.txt" ios
