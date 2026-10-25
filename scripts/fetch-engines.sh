#!/usr/bin/env bash
# Fetches a native Stockfish build into engines/stockfish/stockfish (engines/ is git-ignored).
#
# Usage: scripts/fetch-engines.sh [--force] [--no-verify]
# Env:   STOCKFISH_VERSION  release tag, e.g. sf_19 (default: latest stable release)
#        STOCKFISH_ARCH     build flavour override, e.g. x86-64-sse41-popcnt
#        STOCKFISH_SHA256   expected sha256 of the asset; overrides the digest GitHub publishes
#        GITHUB_TOKEN       optional, raises the API rate limit
#
# Supply chain (docs/SECURITY.md): the download is verified against the sha256 digest the GitHub
# release API publishes for the asset (or STOCKFISH_SHA256). The script fails closed when the
# digest cannot be obtained or checked; --no-verify downgrades that to a warning. Parsing the
# release metadata needs jq or node (both fail closed otherwise, --no-verify falls back to sed).
#
# NNUE networks are embedded in the official Stockfish binaries, so no separate
# NNUE download is needed.
#
# Maia (ADR-019): afterwards (also when Stockfish is already present) this runs
# scripts/fetch-maia.sh, which fetches the nine Maia nets into engines/maia/ (pinned commit,
# sha256-verified). Skip it with MAIA=off. The Lc0 binary that runs them is built separately
# by scripts/build-lc0.sh (pnpm build-lc0).
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
VERIFY=1
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    --no-verify) VERIFY=0 ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
# Verification failure: fatal unless --no-verify was given.
unverified() {
  if [[ $VERIFY -eq 1 ]]; then
    die "$* (pass --no-verify to continue without checksum verification)"
  fi
  echo "warning: $* (continuing because of --no-verify)" >&2
}

banner() { (echo uci; sleep 0.3) | "$DEST_BIN" 2>/dev/null | head -1 || true; }

# Maia nets (ADR-019); forwards --force/--no-verify. MAIA=off skips them.
fetch_maia() {
  if [[ "${MAIA:-on}" == off ]]; then
    echo "MAIA=off: skipping the Maia nets"
    return 0
  fi
  local args=()
  [[ $FORCE -eq 1 ]] && args+=(--force)
  [[ $VERIFY -eq 0 ]] && args+=(--no-verify)
  "$ROOT/scripts/fetch-maia.sh" "${args[@]}"
}

if [[ -x "$DEST_BIN" && $FORCE -eq 0 ]]; then
  echo "Stockfish already present at $DEST_BIN (use --force to re-download)"
  banner
  fetch_maia
  exit 0
fi

for tool in curl tar; do
  command -v "$tool" >/dev/null || die "missing required tool: $tool"
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
    *) die "unsupported platform: $os/$machine" ;;
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

# Lines of "<name>\t<url>\t<digest>" for every asset of the release (digest may be empty).
if command -v jq >/dev/null; then
  TAG="$(jq -r '.tag_name' <<<"$release_json")"
  assets="$(jq -r '.assets[] | "\(.name)\t\(.browser_download_url)\t\(.digest // "")"' <<<"$release_json")"
elif command -v node >/dev/null; then
  TAG="$(node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(r.tag_name??""))' <<<"$release_json")"
  assets="$(node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const a of r.assets??[])console.log([a.name,a.browser_download_url,a.digest??""].join("\t"))' <<<"$release_json")"
else
  unverified "neither jq nor node is available to read the release metadata (digests unavailable)"
  TAG="$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' <<<"$release_json" | head -1)"
  assets="$(sed -n 's/.*"browser_download_url": *"\([^"]*\)".*/\1/p' <<<"$release_json" | awk -F/ '{print $NF "\t" $0 "\t"}')"
fi
[[ -n "$TAG" ]] || die "could not determine release tag"
echo "Release: $TAG"

# ---- asset selection ----------------------------------------------------------------
case "$os" in
  Linux)  candidates=("stockfish-ubuntu-$ARCH.tar" "stockfish-linux-x86-64-universal.tar.gz") ;;
  Darwin) candidates=("stockfish-macos-$ARCH.tar" "stockfish-macos-universal.tar.gz") ;;
esac
[[ "$os/$machine" == "Linux/x86_64" ]] || [[ "$os" == Darwin ]] || die "unsupported platform"

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
[[ "$url" == https://github.com/* || "$url" == https://objects.githubusercontent.com/* ]] \
  || die "refusing to download from unexpected host: $url"
echo "Asset: $asset"

# ---- expected checksum ----------------------------------------------------------------
expected=""
if [[ -n "${STOCKFISH_SHA256:-}" ]]; then
  expected="$(tr 'A-F' 'a-f' <<<"${STOCKFISH_SHA256#sha256:}")"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "STOCKFISH_SHA256 is not a 64-digit hex sha256"
  if [[ "$digest" == sha256:* && "${digest#sha256:}" != "$expected" ]]; then
    die "STOCKFISH_SHA256 ($expected) differs from the digest GitHub publishes for $asset (${digest#sha256:})"
  fi
elif [[ "$digest" == sha256:* ]]; then
  expected="${digest#sha256:}"
else
  unverified "GitHub publishes no sha256 digest for $asset and STOCKFISH_SHA256 is not set"
fi

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null; then openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else echo ""; fi
}

# ---- download + extract (never executes archive content other than the final binary) -
mkdir -p "$ENGINES_DIR/.tmp"
tmp="$(mktemp -d "$ENGINES_DIR/.tmp/stockfish.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
curl -fSL --progress-bar -o "$tmp/$asset" "$url"

if [[ -n "$expected" ]]; then
  actual="$(sha256_of "$tmp/$asset")"
  if [[ -z "$actual" ]]; then
    unverified "no sha256 tool (sha256sum, shasum, openssl) found to verify $asset"
  elif [[ "$actual" != "$expected" ]]; then
    die "checksum mismatch for $asset: expected $expected, got $actual"
  else
    echo "sha256 verified ($expected)"
  fi
fi

mkdir "$tmp/x"
tar -xf "$tmp/$asset" -C "$tmp/x"
# The engine is the only executable regular file named stockfish* (docs/scripts are not executable).
mapfile -t bins < <(find "$tmp/x" -type f -name 'stockfish*' -perm -u+x ! -path '*/src/*' ! -path '*/scripts/*')
[[ ${#bins[@]} -eq 1 ]] || die "expected exactly one stockfish binary in archive, found ${#bins[@]}"

mkdir -p "$DEST_DIR"
install -m 0755 "${bins[0]}" "$DEST_BIN.new"
mv -f "$DEST_BIN.new" "$DEST_BIN"
[[ -f "$tmp/x/stockfish/Copying.txt" ]] && cp "$tmp/x/stockfish/Copying.txt" "$DEST_DIR/Copying.txt"
printf '%s\n%s\n%s\n' "$TAG" "$asset" "sha256:${expected:-unverified}" > "$DEST_DIR/VERSION"

# ---- smoke test ---------------------------------------------------------------------
out="$( (printf 'uci\nisready\nposition startpos\ngo depth 8\n'; sleep 3; echo quit) | "$DEST_BIN" 2>&1 )"
if ! { grep -q '^uciok' <<<"$out" && grep -q '^readyok' <<<"$out" && grep -q '^bestmove' <<<"$out"; }; then
  echo "smoke test failed:" >&2; echo "$out" >&2; exit 1
fi
banner
echo "Installed $DEST_BIN ($TAG)"
fetch_maia
