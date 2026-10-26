#!/usr/bin/env bash
# Builds a signed release AAB on this host for the FIRST manual Play Console upload (M26-8;
# deploy/README.md "Mobile release"), without waiting for CI. Run by the OWNER, interactively.
# Prompts for the keystore password (hidden); it lives only in this process' environment.
#
# Usage: scripts/mobile/build-signed-aab.sh <upload keystore .p12> [versionCode]
#   versionCode defaults to 1. Every later upload needs a higher one; CI uses the workflow run
#   number, so after a manual upload with N the next CI release must have run number > N.
# Output: apps/mobile/android/app/build/outputs/bundle/release/app-release.aab (git-ignored).
set -euo pipefail

KEYSTORE=${1:-}
VERSION_CODE=${2:-1}
ALIAS=${ANDROID_UPLOAD_KEY_ALIAS:-daisychess-upload}
[[ -n "$KEYSTORE" && -f "$KEYSTORE" ]] || { echo "usage: $0 <upload keystore .p12> [versionCode]" >&2; exit 1; }
[[ "$VERSION_CODE" =~ ^[1-9][0-9]*$ ]] || { echo "versionCode must be a positive integer" >&2; exit 1; }
[[ -t 0 ]] || { echo "run this interactively (it prompts for the password)" >&2; exit 1; }
KEYSTORE=$(cd "$(dirname "$KEYSTORE")" && pwd)/$(basename "$KEYSTORE")
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

read -rsp "Upload keystore password: " pw
echo
export ANDROID_UPLOAD_KEYSTORE_FILE="$KEYSTORE"
export ANDROID_UPLOAD_KEYSTORE_PASSWORD="$pw"
export ANDROID_UPLOAD_KEY_PASSWORD="$pw"
export ANDROID_UPLOAD_KEY_ALIAS="$ALIAS"
export DAISYCHESS_VERSION_CODE="$VERSION_CODE"
unset pw
# Fail before the long build when the password or alias is wrong.
keytool -list -keystore "$KEYSTORE" -alias "$ALIAS" -storepass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD > /dev/null

cd "$ROOT"
pnpm install --frozen-lockfile
pnpm --filter @daisychess/engine-core build
pnpm --filter @daisychess/mobile build
(cd apps/mobile/android && ./gradlew --no-daemon bundleRelease)

aab="$ROOT/apps/mobile/android/app/build/outputs/bundle/release/app-release.aab"
jarsigner -verify -strict "$aab" > /dev/null
version=$(node -p "require('$ROOT/apps/mobile/package.json').version")
echo
echo "Signed AAB: $aab"
echo "versionName $version, versionCode $VERSION_CODE"
keytool -printcert -jarfile "$aab" | grep -E '^(Owner|[[:space:]]*SHA256):'
echo "Upload it in Play Console → DaisyChess → Test and release → Testing → Internal testing → Create new release."
