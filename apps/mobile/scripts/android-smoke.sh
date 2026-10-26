#!/usr/bin/env bash
# Android emulator smoke (CI job `mobile`, ADR-022): installs the debug APK, starts the app and
# waits for the DAISYCHESS_SMOKE line of the smoke build (VITE_MOBILE_SMOKE=1) in logcat, then
# asserts it with check-smoke-log.mjs. Needs a running emulator/device (`adb`).
# Usage: android-smoke.sh <apk> <out dir> [timeout seconds]
# SMOKE_SERVER_PORT=<port>: an engine server listens on the host's 127.0.0.1:<port> and the build
# has VITE_MOBILE_SMOKE_SERVER_URL=ws://127.0.0.1:<port>/ws (M26-2). `adb reverse` maps the
# emulator's loopback to it (10.0.2.2 would be mixed content from https://app.daisychess.org;
# loopback is potentially trustworthy), and the app must receive `welcome`.
set -euo pipefail
APK=$1
OUT=$2
TIMEOUT=${3:-240}
APP_ID=org.daisychess.app
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"

# Install/launch race on CI emulators: right after boot the package manager may not answer yet,
# and `am start` directly after `install` can fail ("Activity class does not exist") or the process
# dies before the WebView loads. Wait for the package manager, retry install and launch, and
# relaunch (at most twice) when the app process is gone before the smoke line appeared.
adb wait-for-device
for _ in $(seq 1 60); do
  if [[ "$(adb shell getprop sys.boot_completed 2> /dev/null | tr -d '\r')" == 1 ]] \
    && adb shell pm path android > /dev/null 2>&1; then
    break
  fi
  sleep 2
done

retry() {
  local n=$1 i
  shift
  for ((i = 1; i <= n; i++)); do
    "$@" && return 0
    echo "attempt $i/$n failed: $*" >&2
    sleep $((i * 3))
  done
  return 1
}

# True when `am start` succeeded and the app process is up within 15 s.
launch_once() {
  local out
  out=$(adb shell am start -W -n "$APP_ID/.MainActivity" 2>&1) || true
  echo "$out"
  if grep -qE 'Error|Exception|does not exist' <<< "$out"; then
    adb shell am force-stop "$APP_ID" || true
    return 1
  fi
  for _ in $(seq 1 15); do
    adb shell pidof "$APP_ID" > /dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

retry 3 adb install -r "$APK"
CHECK_FLAGS=()
if [[ -n "${SMOKE_SERVER_PORT:-}" ]]; then
  adb reverse "tcp:$SMOKE_SERVER_PORT" "tcp:$SMOKE_SERVER_PORT"
  CHECK_FLAGS+=(--expect-welcome)
fi
adb logcat -c
retry 4 launch_once || echo "app did not start after 4 attempts" >&2

deadline=$((SECONDS + TIMEOUT))
found=0
relaunches=0
while ((SECONDS < deadline)); do
  adb logcat -d > "$OUT/logcat.txt" || true
  if grep -q 'DAISYCHESS_SMOKE {' "$OUT/logcat.txt"; then
    found=1
    break
  fi
  if ((relaunches < 2)) && ! adb shell pidof "$APP_ID" > /dev/null 2>&1; then
    relaunches=$((relaunches + 1))
    echo "app process gone before the smoke result; relaunch $relaunches" >&2
    launch_once || true
  fi
  sleep 3
done
adb logcat -d > "$OUT/logcat.txt" || true
grep -E 'Capacitor|chromium|DAISYCHESS' "$OUT/logcat.txt" > "$OUT/logcat-app.txt" || true
adb exec-out screencap -p > "$OUT/screen.png" || true
adb shell am force-stop "$APP_ID" || true
((found)) || echo "no smoke result within ${TIMEOUT}s" >&2
node "$HERE/check-smoke-log.mjs" "$OUT/logcat.txt" android ${CHECK_FLAGS[@]+"${CHECK_FLAGS[@]}"}
