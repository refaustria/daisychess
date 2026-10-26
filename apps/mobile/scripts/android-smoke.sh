#!/usr/bin/env bash
# Android emulator smoke (CI job `mobile`, ADR-022): installs the debug APK, starts the app and
# waits for the DAISYCHESS_SMOKE line of the smoke build (VITE_MOBILE_SMOKE=1) in logcat, then
# asserts it with check-smoke-log.mjs. Needs a running emulator/device (`adb`).
# Usage: android-smoke.sh <apk> <out dir> [timeout seconds]
set -euo pipefail
APK=$1
OUT=$2
TIMEOUT=${3:-240}
APP_ID=org.daisychess.app
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"

adb wait-for-device
adb install -r "$APK"
adb logcat -c
adb shell am start -W -n "$APP_ID/.MainActivity"

deadline=$((SECONDS + TIMEOUT))
found=0
while ((SECONDS < deadline)); do
  adb logcat -d > "$OUT/logcat.txt" || true
  if grep -q 'DAISYCHESS_SMOKE {' "$OUT/logcat.txt"; then
    found=1
    break
  fi
  sleep 3
done
adb logcat -d > "$OUT/logcat.txt" || true
grep -E 'Capacitor|chromium|DAISYCHESS' "$OUT/logcat.txt" > "$OUT/logcat-app.txt" || true
adb exec-out screencap -p > "$OUT/screen.png" || true
adb shell am force-stop "$APP_ID" || true
((found)) || echo "no smoke result within ${TIMEOUT}s" >&2
node "$HERE/check-smoke-log.mjs" "$OUT/logcat.txt" android
