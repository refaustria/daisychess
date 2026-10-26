#!/usr/bin/env bash
# Sets the iOS signing secrets of the mobile release workflow (M26-8; deploy/README.md "Mobile
# release"). Run by the OWNER from the repository directory with `gh` logged in.
#
# Without --apply it only prints the commands. With --apply it checks the .p12 password locally
# (openssl, password via the environment, never on a command line) and sets
#   IOS_DIST_CERT_P12_B64   ← base64 of the .p12 (read from the file, piped into gh)
#   IOS_DIST_CERT_PASSWORD  ← the password you type (hidden prompt, piped into gh)
#   IOS_PROVISIONING_PROFILE_B64 ← only when a .mobileprovision is given (optional override; the
#                                  workflow normally creates the profile through the ASC API)
# ASC_API_KEY_P8_B64 and the variables APPLE_TEAM_ID, ASC_KEY_ID, ASC_ISSUER_ID are set already.
#
# Usage: scripts/mobile/set-ios-secrets.sh [--apply] <distribution.p12> [profile.mobileprovision]
set -euo pipefail

APPLY=0
if [[ "${1:-}" == --apply ]]; then
  APPLY=1
  shift
fi
P12=${1:-}
PROFILE=${2:-}
if [[ -z "$P12" ]]; then
  echo "usage: $0 [--apply] <distribution.p12> [profile.mobileprovision]" >&2
  exit 1
fi
[[ -f "$P12" ]] || { echo "$P12 not found" >&2; exit 1; }
[[ -z "$PROFILE" || -f "$PROFILE" ]] || { echo "$PROFILE not found" >&2; exit 1; }

b64() { base64 < "$1" | tr -d '\n'; }

if ((APPLY == 0)); then
  cat << MSG
Run from the repository directory (or rerun this script with --apply):

  gh secret set IOS_DIST_CERT_P12_B64 < <(base64 < "$P12" | tr -d '\\n')
  gh secret set IOS_DIST_CERT_PASSWORD      # gh prompts; paste the .p12 password
MSG
  if [[ -n "$PROFILE" ]]; then
    printf '  gh secret set IOS_PROVISIONING_PROFILE_B64 < <(base64 < "%s" | tr -d '"'"'\\n'"'"')\n' "$PROFILE"
  fi
  exit 0
fi

command -v gh > /dev/null || { echo "gh not found" >&2; exit 1; }
[[ -t 0 ]] || { echo "--apply must run interactively" >&2; exit 1; }
read -rsp ".p12 password: " pw
echo
export DAISYCHESS_P12_PW="$pw"
unset pw
trap 'unset DAISYCHESS_P12_PW' EXIT

# Check the password and that the file holds a distribution identity (OpenSSL 3 needs -legacy for
# the RC2/3DES encryption of .p12 files exported by older Keychain Access versions).
subject=''
for legacy in '' -legacy; do
  # shellcheck disable=SC2086 # empty or one flag
  if subject=$(openssl pkcs12 $legacy -in "$P12" -passin env:DAISYCHESS_P12_PW -nokeys -clcerts 2> /dev/null \
    | openssl x509 -noout -subject -enddate 2> /dev/null) && [[ -n "$subject" ]]; then
    break
  fi
  subject=''
done
if [[ -z "$subject" ]]; then
  echo "could not open $P12 with that password" >&2
  exit 1
fi
echo "$subject"
if ! grep -qE '(Apple|iPhone) Distribution' <<< "$subject"; then
  echo "warning: the certificate is not an Apple/iPhone Distribution certificate" >&2
fi

b64 "$P12" | gh secret set IOS_DIST_CERT_P12_B64
printf '%s' "$DAISYCHESS_P12_PW" | gh secret set IOS_DIST_CERT_PASSWORD
if [[ -n "$PROFILE" ]]; then
  b64 "$PROFILE" | gh secret set IOS_PROVISIONING_PROFILE_B64
fi
echo "done: gh secret list | grep IOS_"
