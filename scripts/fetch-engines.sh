#!/usr/bin/env bash
# Fetches a native Stockfish build into engines/stockfish/stockfish (engines/ is git-ignored).
#
# Usage: scripts/fetch-engines.sh [--force]
# Env:   STOCKFISH_VERSION  release tag, e.g. sf_17.1 (default: latest stable release)
#        STOCKFISH_ARCH     build flavour override, e.g. x86-64-sse41-popcnt
#
# NNUE networks are embedded in the official Stockfish binaries, so no separate
# NNUE download is needed.
#
# Asset naming differs between releases:
#   sf_18 and older: per-CPU tarballs  stockfish-ubuntu-<arch>.tar / stockfish-macos-<arch>.tar
#   sf_19 and newer: "universal" tarballs (stockfish-linux-x86-64-universal.tar.gz) that
#                    pick the best instruction set at runtime (sse41-popcnt on CPUs w/o AVX2, see ADR-003).
# The script prefers a per-CPU asset when the release lists one and falls back to the universal one.
set -euo pipefail

REPO="official-stockfish/Stockfish"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINES_DIR="$ROOT/engines"
DEST_DIR="$ENGINES_DIR/stockfish"
DEST_BIN="$DEST_DIR/stockfish"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

banner() { (echo uci; sleep 0.3) | "$DEST_BIN" 2>/dev/null | head -1 || true; }

if [[ -x "$DEST_BIN" && $FORCE -eq 0 ]]; then
  echo "Stockfish already present at $DEST_BIN (use --force to re-download)"
  banner
  exit 0
fi

for tool in curl tar; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

# ---- CPU / platform detection -------------------------------------------------------
os="$(uname -s)"
machine="$(uname -m)"
detect_arch() {
  if [[ -n "${STOCKFISH_ARCH:-}" ]]; then echo "$STOCKFISH_ARCH"; return; fi
  case "$os/$machine" in
    Linux/x86_64)
      local flags
      flags=" $(grep -m1 '^flags' /proc/cpuinfo | cut -d: -f2) "
      has() { [[ "$flags" == *" $1 "* ]]; }
      if has avx512f && has avx512bw && has avx512vl && has avx512dq && has avx512vnni; then echo x86-64-vnni512
      elif has avx512f && has avx512bw && has avx512vl && has avx512dq; then echo x86-64-avx512
      elif has bmi2 && has avx2; then echo x86-64-bmi2
      elif has avx2; then echo x86-64-avx2
      elif has sse4_1 && has popcnt; then echo x86-64-sse41-popcnt
      else echo x86-64; fi ;;
    Darwin/arm64) echo m1-apple-silicon ;;
    Darwin/x86_64)
      if sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qw AVX2; then echo x86-64-avx2
      elif sysctl -n machdep.cpu.features 2>/dev/null | grep -qw SSE4.1; then echo x86-64-sse41-popcnt
      else echo x86-64; fi ;;
    *) echo "unsupported platform: $os/$machine" >&2; exit 1 ;;
  esac
}
ARCH="$(detect_arch)"
echo "Platform: $os/$machine, Stockfish arch: $ARCH"

# ---- release lookup -----------------------------------------------------------------
if [[ -n "${STOCKFISH_VERSION:-}" ]]; then
  api="https://api.github.com/repos/$REPO/releases/tags/$STOCKFISH_VERSION"
else
  api="https://api.github.com/repos/$REPO/releases/latest"
fi
curl_args=(-fsSL -H "Accept: application/vnd.github+json")
[[ -n "${GITHUB_TOKEN:-}" ]] && curl_args+=(-H "Authorization: Bearer $GITHUB_TOKEN")
release_json="$(curl "${curl_args[@]}" "$api")"

if command -v jq >/dev/null; then
  TAG="$(jq -r '.tag_name' <<<"$release_json")"
  assets="$(jq -r '.assets[] | "\(.name)\t\(.browser_download_url)\t\(.digest // "")"' <<<"$release_json")"
else
  TAG="$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' <<<"$release_json" | head -1)"
  # Without jq: names and URLs only (no digest verification).
  assets="$(sed -n 's/.*"browser_download_url": *"\([^"]*\)".*/\1/p' <<<"$release_json" | awk -F/ '{print $NF "\t" $0 "\t"}')"
fi
[[ -n "$TAG" ]] || { echo "could not determine release tag" >&2; exit 1; }
echo "Release: $TAG"

# ---- asset selection ----------------------------------------------------------------
case "$os" in
  Linux)  candidates=("stockfish-ubuntu-$ARCH.tar" "stockfish-linux-x86-64-universal.tar.gz") ;;
  Darwin) candidates=("stockfish-macos-$ARCH.tar" "stockfish-macos-universal.tar.gz") ;;
esac
[[ "$os/$machine" == "Linux/x86_64" ]] || [[ "$os" == Darwin ]] || { echo "unsupported platform" >&2; exit 1; }

asset="" url="" digest=""
for c in "${candidates[@]}"; do
  line="$(awk -F'\t' -v n="$c" '$1 == n' <<<"$assets" | head -1)"
  if [[ -n "$line" ]]; then
    asset="$c"; url="$(cut -f2 <<<"$line")"; digest="$(cut -f3 <<<"$line")"; break
  fi
done
if [[ -z "$asset" ]]; then
  echo "no matching asset in $TAG for $ARCH; available:" >&2
  cut -f1 <<<"$assets" >&2
  exit 1
fi
echo "Asset: $asset"

# ---- download + extract (never executes archive content other than the final binary) -
mkdir -p "$ENGINES_DIR/.tmp"
tmp="$(mktemp -d "$ENGINES_DIR/.tmp/stockfish.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
curl -fSL --progress-bar -o "$tmp/$asset" "$url"

if [[ "$digest" == sha256:* ]] && command -v sha256sum >/dev/null; then
  echo "${digest#sha256:}  $tmp/$asset" | sha256sum -c - >/dev/null || { echo "checksum mismatch" >&2; exit 1; }
  echo "sha256 verified"
fi

mkdir "$tmp/x"
tar -xf "$tmp/$asset" -C "$tmp/x"
# The engine is the only executable regular file named stockfish* (docs/scripts are not executable).
mapfile -t bins < <(find "$tmp/x" -type f -name 'stockfish*' -perm -u+x ! -path '*/src/*' ! -path '*/scripts/*')
[[ ${#bins[@]} -eq 1 ]] || { echo "expected exactly one stockfish binary in archive, found ${#bins[@]}" >&2; exit 1; }

mkdir -p "$DEST_DIR"
install -m 0755 "${bins[0]}" "$DEST_BIN.new"
mv -f "$DEST_BIN.new" "$DEST_BIN"
[[ -f "$tmp/x/stockfish/Copying.txt" ]] && cp "$tmp/x/stockfish/Copying.txt" "$DEST_DIR/Copying.txt"
printf '%s\n%s\n' "$TAG" "$asset" > "$DEST_DIR/VERSION"

# ---- smoke test ---------------------------------------------------------------------
out="$( (printf 'uci\nisready\nposition startpos\ngo depth 8\n'; sleep 3; echo quit) | "$DEST_BIN" 2>&1 )"
if ! { grep -q '^uciok' <<<"$out" && grep -q '^readyok' <<<"$out" && grep -q '^bestmove' <<<"$out"; }; then
  echo "smoke test failed:" >&2; echo "$out" >&2; exit 1
fi
banner
echo "Installed $DEST_BIN ($TAG)"
