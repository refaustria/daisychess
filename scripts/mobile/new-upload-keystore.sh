#!/usr/bin/env bash
# Creates the DaisyChess Android *upload* keystore (PKCS12, RSA 4096, ~27 years) for Play App
# Signing (ADR-022 §6, M26-8; deploy/README.md "Mobile release"). Run by the OWNER, interactively.
#
# - Prompts for the password (twice, hidden); it is passed to keytool through the environment of
#   this process only and is written nowhere except into the keystore itself.
# - Refuses to write inside the git repository or to overwrite an existing file.
# - Prints the upload certificate's SHA-256 fingerprint and the `gh secret set` commands you run
#   yourself (gh prompts for the password again; nothing secret appears in the commands).
#
# Usage: scripts/mobile/new-upload-keystore.sh [keystore path]   (default ~/daisychess-upload.p12)
# Keep the keystore and the password in your password manager / backup. Losing them is recoverable
# (Play Console → App integrity → request an upload key reset), but takes days.
set -euo pipefail

KEYSTORE=${1:-$HOME/daisychess-upload.p12}
ALIAS=daisychess-upload
DNAME='CN=DaisyChess Upload Key, O=INCEPTUM e.U., C=AT'

command -v keytool > /dev/null || { echo "keytool not found (install a JDK, e.g. openjdk-21-jdk-headless)" >&2; exit 1; }
[[ -t 0 ]] || { echo "run this interactively (it prompts for the password)" >&2; exit 1; }

dir=$(cd "$(dirname "$KEYSTORE")" && pwd) || { echo "directory of $KEYSTORE does not exist" >&2; exit 1; }
KEYSTORE="$dir/$(basename "$KEYSTORE")"
if top=$(git -C "$dir" rev-parse --show-toplevel 2> /dev/null); then
  echo "refusing to create the keystore inside the git work tree $top" >&2
  exit 1
fi
if [[ -e "$KEYSTORE" ]]; then
  echo "$KEYSTORE exists; refusing to overwrite (move it away first if you really want a new key)" >&2
  exit 1
fi

read -rsp "New keystore password (min. 12 characters): " pw1
echo
read -rsp "Repeat the password: " pw2
echo
if [[ "$pw1" != "$pw2" ]]; then
  echo "passwords differ" >&2
  exit 1
fi
if ((${#pw1} < 12)); then
  echo "password too short" >&2
  exit 1
fi
# PKCS12: key password = store password. Exported only into this process' environment for keytool.
export DAISYCHESS_KS_PW="$pw1"
unset pw1 pw2
trap 'unset DAISYCHESS_KS_PW' EXIT

umask 077
keytool -genkeypair -v -storetype PKCS12 -keystore "$KEYSTORE" -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -sigalg SHA256withRSA -validity 10000 -dname "$DNAME" \
  -storepass:env DAISYCHESS_KS_PW -keypass:env DAISYCHESS_KS_PW > /dev/null
chmod 600 "$KEYSTORE"

cert="${KEYSTORE%.*}-cert.pem"
keytool -exportcert -rfc -keystore "$KEYSTORE" -alias "$ALIAS" -storepass:env DAISYCHESS_KS_PW > "$cert"
chmod 644 "$cert"
fingerprint=$(keytool -list -v -keystore "$KEYSTORE" -alias "$ALIAS" -storepass:env DAISYCHESS_KS_PW \
  | sed -n 's/^[[:space:]]*SHA256: //p')

cat << MSG

Created $KEYSTORE (alias $ALIAS, PKCS12; key password = keystore password).
Upload certificate (public): $cert
Upload certificate SHA-256: $fingerprint
  (Play Console → Test and release → App integrity → App signing shows it as the "upload key"
   after the first upload. It is NOT the app signing fingerprint for assetlinks.json.)

Back up the keystore file and the password now (password manager), then set the repository
secrets yourself from the repository directory (gh prompts for the password; paste it there):

  gh secret set ANDROID_UPLOAD_KEYSTORE_B64 < <(base64 < "$KEYSTORE" | tr -d '\\n')
  gh secret set ANDROID_UPLOAD_KEY_ALIAS --body $ALIAS
  gh secret set ANDROID_UPLOAD_KEYSTORE_PASSWORD
  gh secret set ANDROID_UPLOAD_KEY_PASSWORD        # the same password

First Play upload without waiting for CI:  scripts/mobile/build-signed-aab.sh "$KEYSTORE"
MSG
