#!/usr/bin/env bash
# Verifies the upload keystore password locally with keytool, then sets the Android signing
# secrets (store password, key password, key alias) from that same input. Run it interactively;
# the password is never echoed, logged or passed on the command line.
# Usage: scripts/mobile/set-android-secrets.sh [keystore.p12]
set -euo pipefail
KS="${1:-$HOME/daisychess-upload.p12}"
REPO="refaustria/daisychess"
[ -t 0 ] || { echo "run this in a terminal (interactive)" >&2; exit 1; }
[ -f "$KS" ] || { echo "keystore not found: $KS" >&2; exit 1; }
command -v keytool >/dev/null || { echo "keytool missing (install a JDK)" >&2; exit 1; }

read -rsp "Keystore password: " PW; echo
if ! out=$(printf '%s\n' "$PW" | keytool -list -storetype PKCS12 -keystore "$KS" 2>&1); then
  unset PW
  echo "FAILED: keytool rejects this password for $KS" >&2
  exit 1
fi
alias=$(printf '%s\n' "$out" | awk -F, '/PrivateKeyEntry/ {print $1; exit}')
[ -n "$alias" ] || { unset PW; echo "FAILED: no private key entry in $KS" >&2; exit 1; }
echo "Password OK, key alias: $alias"

printf %s "$PW" | gh secret set ANDROID_UPLOAD_KEYSTORE_PASSWORD -R "$REPO"
printf %s "$PW" | gh secret set ANDROID_UPLOAD_KEY_PASSWORD -R "$REPO"
printf %s "$alias" | gh secret set ANDROID_UPLOAD_KEY_ALIAS -R "$REPO"
unset PW
echo "OK: ANDROID_UPLOAD_KEYSTORE_PASSWORD, ANDROID_UPLOAD_KEY_PASSWORD, ANDROID_UPLOAD_KEY_ALIAS set"
