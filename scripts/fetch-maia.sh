#!/usr/bin/env bash
# Fetches the nine Maia networks (human-like Lc0 weights, lichess ratings 1100…1900) into
# engines/maia/ (git-ignored), sha256-verified against the digests pinned below (ADR-019).
#
# Usage: scripts/fetch-maia.sh [--force] [--no-verify]
# Env:   MAIA_COMMIT     commit of github.com/CSSLab/maia-chess to fetch from (default pinned);
#                        another commit needs MAIA_SHA256SUMS or --no-verify
#        MAIA_SHA256SUMS path to a sha256sum-format file ("<digest>  maia-1100.pb.gz" per line)
#                        replacing the pinned digests
#
# Source and licence: Maia (CSSLab, University of Toronto; McIlroy-Young et al., KDD 2020) is
# GPL-3.0, like Lc0 and Stockfish. The nets only run on the engine server (never shipped to the
# browser); this repository is GPL-3.0 as well. engines/maia/SOURCE.md records what was fetched.
# Fails closed: a missing or wrong digest aborts unless --no-verify. Idempotent: files whose
# digest already matches are kept (--force re-downloads).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINES_DIR="$ROOT/engines"
DEST_DIR="$ENGINES_DIR/maia"
REPO="CSSLab/maia-chess"
MAIA_COMMIT="${MAIA_COMMIT:-749204cf5979ce7f8b0412e804a4ee7c83c49ff8}"
RATINGS=(1100 1200 1300 1400 1500 1600 1700 1800 1900)

# Pinned sha256 digests of maia_weights/*.pb.gz at the default commit (recorded 2026-10-25).
PINNED_SHA256SUMS="$(cat <<'EOF'
e1cf1cd0c96b8a4fa6a275f4b9fd54ed1ffebf9fe44641b9fceded310e9619c4  maia-1100.pb.gz
ead4ba953f233ae732999ebc1e2b675378148527ebcfad2f0acbc5e4c224d98e  maia-1200.pb.gz
36195f87bf4761834baa0bf87472b18509a7261a9d7d6f1a8443261369a733f2  maia-1300.pb.gz
d5353ea6766356dad2d28920c6692f37a5f30963767f1a3105d33b4d0af011e8  maia-1400.pb.gz
35ab6f20421d59e1df3b17c5a5016947af4c6761368ef84044a9a9c7619a9a00  maia-1500.pb.gz
d2c9e5948581acf4b9fc0b1e720c5dc0fe64ce80cfc4a239d3f8a42e1176c876  maia-1600.pb.gz
d277eacd792d340a30abb464dc65127254e65cac57abca17facc469889b96478  maia-1700.pb.gz
0031ad7c4256b1fd09fbebd28418d644d68b26cd2a45df4967ccf5c7ec9c4965  maia-1800.pb.gz
e2f565f42d7cd9f122557e6dc4eb84e5bbaedceda1d404dc485d3611c7c97a12  maia-1900.pb.gz
EOF
)"

FORCE=0
VERIFY=1
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    --no-verify) VERIFY=0 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
unverified() {
  if [[ $VERIFY -eq 1 ]]; then
    die "$* (pass --no-verify to continue without checksum verification)"
  fi
  echo "warning: $* (continuing because of --no-verify)" >&2
}
for tool in curl gzip; do
  command -v "$tool" >/dev/null || die "missing required tool: $tool"
done
sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null; then openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else echo ""; fi
}

# Expected digests: pinned for the default commit, else from MAIA_SHA256SUMS.
if [[ -n "${MAIA_SHA256SUMS:-}" ]]; then
  [[ -r "$MAIA_SHA256SUMS" ]] || die "MAIA_SHA256SUMS ($MAIA_SHA256SUMS) is not readable"
  sums="$(cat "$MAIA_SHA256SUMS")"
elif [[ "$MAIA_COMMIT" == "749204cf5979ce7f8b0412e804a4ee7c83c49ff8" ]]; then
  sums="$PINNED_SHA256SUMS"
else
  unverified "no pinned digests for commit $MAIA_COMMIT (set MAIA_SHA256SUMS)"
  sums=""
fi
expected_for() { awk -v n="$1" '$2 == n { print tolower($1) }' <<<"$sums" | head -1; }

mkdir -p "$DEST_DIR" "$ENGINES_DIR/.tmp"
tmp="$(mktemp -d "$ENGINES_DIR/.tmp/maia.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

fetched=0 kept=0
for r in "${RATINGS[@]}"; do
  name="maia-$r.pb.gz"
  dest="$DEST_DIR/$name"
  expected="$(expected_for "$name")"
  [[ -z "$expected" || "$expected" =~ ^[0-9a-f]{64}$ ]] || die "bad digest for $name in checksum list"
  if [[ -f "$dest" && $FORCE -eq 0 && -n "$expected" && "$(sha256_of "$dest")" == "$expected" ]]; then
    kept=$((kept + 1))
    continue
  fi
  url="https://raw.githubusercontent.com/$REPO/$MAIA_COMMIT/maia_weights/$name"
  echo "Downloading $url"
  curl -fsSL -o "$tmp/$name" "$url"
  if [[ -n "$expected" ]]; then
    actual="$(sha256_of "$tmp/$name")"
    if [[ -z "$actual" ]]; then
      unverified "no sha256 tool (sha256sum, shasum, openssl) found to verify $name"
    elif [[ "$actual" != "$expected" ]]; then
      die "checksum mismatch for $name: expected $expected, got $actual"
    fi
  else
    unverified "no digest for $name"
  fi
  gzip -t "$tmp/$name" || die "$name is not a valid gzip file"
  install -m 0644 "$tmp/$name" "$dest.new"
  mv -f "$dest.new" "$dest"
  fetched=$((fetched + 1))
done

# Provenance record next to the files (engines/ is git-ignored, so this travels with them).
{
  echo "# Maia networks — source and licence"
  echo
  echo "Fetched by scripts/fetch-maia.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ) (ADR-019)."
  echo
  echo "- Source: https://github.com/$REPO (maia_weights/, commit \`$MAIA_COMMIT\`)"
  echo "- Authors: Reid McIlroy-Young, Siddhartha Sen, Jon Kleinberg, Ashton Anderson —"
  echo "  \"Aligning Superhuman AI with Human Behavior: Chess as a Model System\", KDD 2020."
  echo "- Licence: GPL-3.0 (same as Lc0, which runs them, and Stockfish). Server-side use only;"
  echo "  nothing of it is shipped to browsers. This repository is GPL-3.0."
  echo "- Format: Lc0 weight files (gzipped protobuf); each net predicts the move a lichess player"
  echo "  of the rating in its name would play. Used with \`lc0 --weights=<net>\` and \`go nodes 1\`."
  echo
  echo "sha256:"
  echo
  echo '```'
  for r in "${RATINGS[@]}"; do
    f="$DEST_DIR/maia-$r.pb.gz"
    [[ -f "$f" ]] && echo "$(sha256_of "$f")  maia-$r.pb.gz"
  done
  echo '```'
} > "$DEST_DIR/SOURCE.md"

echo "Maia nets in $DEST_DIR: $fetched fetched, $kept already present and verified ($(du -sh "$DEST_DIR" | cut -f1))"
