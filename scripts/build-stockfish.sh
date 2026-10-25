#!/usr/bin/env bash
# Builds Stockfish from the pinned, sha256-verified source tag into engines/stockfish/stockfish.
#
# Used by docker/node.Dockerfile for linux/arm64 (M24-8); works on any Linux/macOS host with a
# C++20 compiler. The default ARCH builds Stockfish's own "universal" binary (sf_19+): several
# instruction-set variants in one executable with runtime selection —
#   aarch64: arm64-universal = armv8 (NEON, any 64-bit ARM: Raspberry Pi 4, Graviton 1)
#                              + armv8-dotprod (Pi 5, Apple M*, Graviton 2+, Ampere Altra)
#   x86_64:  x86-64-universal = x86-64 … avx512icl (same set as the official release asset)
# so one image fits every CPU of its architecture and no dispatch logic is needed outside.
#
# Usage: scripts/build-stockfish.sh [--force] [--no-verify]
# Env:   STOCKFISH_VERSION     source tag (default sf_19); another tag needs STOCKFISH_SRC_SHA256
#        STOCKFISH_SRC_SHA256  sha256 of github.com/official-stockfish/Stockfish/archive/refs/tags/<tag>.tar.gz
#        STOCKFISH_BUILD_ARCH  make ARCH (default by host: arm64-universal / x86-64-universal;
#                              e.g. armv8, armv8-dotprod, x86-64-sse41-popcnt for a single variant)
#        STOCKFISH_JOBS        parallel compile jobs (default: nproc)
#        COMP                  compiler family for make (default gcc)
#
# Build dependencies (Debian/Ubuntu): make g++ curl ca-certificates bsdextrautils (hexdump).
# Network: the source tarball (sha256-pinned here) and the default NNUE net, which Stockfish's
# own scripts/net.sh downloads and verifies (the file name nn-<12 hex>.nnue is the prefix of its
# sha256, and the name is fixed by the pinned source). The net is embedded in the binary.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINES_DIR="$ROOT/engines"
DEST_DIR="$ENGINES_DIR/stockfish"
DEST_BIN="$DEST_DIR/stockfish"

STOCKFISH_VERSION="${STOCKFISH_VERSION:-sf_19}"
# Pinned digest (recorded 2026-10-25 from the GitHub archive of the tag).
if [[ "$STOCKFISH_VERSION" == "sf_19" ]]; then
  : "${STOCKFISH_SRC_SHA256:=519b653d0d1ffb96531d982ccbe5c6a19425e8388e0e3c2f70f34b424ab32d76}"
fi
STOCKFISH_SRC_SHA256="${STOCKFISH_SRC_SHA256:-}"

FORCE=0
VERIFY=1
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    --no-verify) VERIFY=0 ;;
    -h|--help) sed -n '2,23p' "${BASH_SOURCE[0]}"; exit 0 ;;
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

if [[ -z "${STOCKFISH_BUILD_ARCH:-}" ]]; then
  case "$(uname -m)" in
    aarch64|arm64) STOCKFISH_BUILD_ARCH=arm64-universal ;;
    x86_64|amd64) STOCKFISH_BUILD_ARCH=x86-64-universal ;;
    *) die "no default STOCKFISH_BUILD_ARCH for $(uname -m); set it explicitly" ;;
  esac
fi
BUILD_ID="source $STOCKFISH_VERSION ARCH=$STOCKFISH_BUILD_ARCH COMP=${COMP:-gcc}"

if [[ -x "$DEST_BIN" && $FORCE -eq 0 && -f "$DEST_DIR/VERSION" ]]; then
  if [[ "$(sed -n 1p "$DEST_DIR/VERSION")" == "$STOCKFISH_VERSION" && "$(sed -n 2p "$DEST_DIR/VERSION")" == "$BUILD_ID" ]]; then
    echo "Stockfish $STOCKFISH_VERSION ($STOCKFISH_BUILD_ARCH) already present at $DEST_BIN (use --force to rebuild)"
    exit 0
  fi
  echo "Stockfish at $DEST_BIN is another version/build; rebuilding"
fi

# hexdump: with compilers lacking `--embed-dir` (gcc < 15) Stockfish's net.sh embeds the NNUE net
# through a hexdump of it; without hexdump it silently embeds an empty net.
for tool in curl tar make hexdump; do
  command -v "$tool" >/dev/null || die "missing build tool: $tool (sudo apt-get install make g++ curl bsdextrautils)"
done

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null; then openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else echo ""; fi
}
# Stockfish's net.sh only validates the NNUE file when a sha256 tool exists; require one.
command -v sha256sum >/dev/null || command -v shasum >/dev/null \
  || unverified "no sha256sum/shasum found (needed to verify the source and the NNUE net)"

# ---- download + verify ---------------------------------------------------------------
mkdir -p "$ENGINES_DIR/.tmp"
tmp="$(mktemp -d "$ENGINES_DIR/.tmp/stockfish-src.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
URL="https://github.com/official-stockfish/Stockfish/archive/refs/tags/$STOCKFISH_VERSION.tar.gz"
echo "Downloading $URL"
curl -fSL --progress-bar -o "$tmp/src.tar.gz" "$URL"
if [[ -n "$STOCKFISH_SRC_SHA256" ]]; then
  actual="$(sha256_of "$tmp/src.tar.gz")"
  [[ -n "$actual" ]] || unverified "no sha256 tool to verify the Stockfish source"
  if [[ -n "$actual" ]]; then
    [[ "$actual" == "$STOCKFISH_SRC_SHA256" ]] \
      || die "checksum mismatch for Stockfish $STOCKFISH_VERSION source: expected $STOCKFISH_SRC_SHA256, got $actual"
    echo "sha256 verified for Stockfish $STOCKFISH_VERSION source ($actual)"
  fi
else
  unverified "no pinned sha256 for the Stockfish $STOCKFISH_VERSION source (set STOCKFISH_SRC_SHA256)"
fi
mkdir "$tmp/src"
tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" --strip-components=1
[[ -f "$tmp/src/src/Makefile" ]] || die "source tarball lacks src/Makefile"

# ---- build ---------------------------------------------------------------------------
JOBS="${STOCKFISH_JOBS:-$(nproc 2>/dev/null || echo 4)}"
echo "Building Stockfish $STOCKFISH_VERSION ARCH=$STOCKFISH_BUILD_ARCH with $JOBS jobs"
start=$(date +%s)
make -C "$tmp/src/src" -j "$JOBS" build ARCH="$STOCKFISH_BUILD_ARCH" COMP="${COMP:-gcc}" \
  > "$tmp/make.log" 2>&1 || { tail -60 "$tmp/make.log" >&2; die "make build failed"; }
grep -E "Successfully validated|Existing .* validated" "$tmp/make.log" | head -2 || true
grep -qE "Successfully validated|Existing .* validated" "$tmp/make.log" \
  || unverified "could not confirm that Stockfish's net.sh validated the NNUE net"
echo "Build finished in $(( $(date +%s) - start )) s"
[[ -x "$tmp/src/src/stockfish" ]] || die "build produced no stockfish binary"
strip "$tmp/src/src/stockfish" 2>/dev/null || true

# ---- smoke test (before install, so a broken build never replaces a working one) -----
# Run a copy from an empty directory: Stockfish also looks for the .nnue file next to the binary
# and in the working directory, which would hide a binary without the embedded net.
net="$(sed -n 's/.*EvalFileDefaultName *"\(nn-[0-9a-f]*\.nnue\)".*/\1/p' "$tmp/src/src/evaluate.h" | head -1)"
[[ -n "$net" && -f "$tmp/src/src/$net" ]] || die "NNUE net $net not found after the build"
bin_size=$(wc -c < "$tmp/src/src/stockfish") net_size=$(wc -c < "$tmp/src/src/$net")
(( bin_size > net_size )) || die "binary ($bin_size bytes) is smaller than the net $net ($net_size bytes): the net was not embedded"
mkdir "$tmp/check"
cp "$tmp/src/src/stockfish" "$tmp/check/stockfish"
out="$(cd "$tmp/check" && (printf 'uci\nisready\nposition startpos\ngo depth 8\n'; sleep 3; echo quit) | ./stockfish 2>&1 )"
if ! { grep -q '^uciok' <<<"$out" && grep -q '^readyok' <<<"$out" && grep -q '^bestmove' <<<"$out"; }; then
  echo "smoke test failed:" >&2; echo "$out" >&2; exit 1
fi

# ---- install -------------------------------------------------------------------------
mkdir -p "$DEST_DIR"
install -m 0755 "$tmp/src/src/stockfish" "$DEST_BIN.new"
mv -f "$DEST_BIN.new" "$DEST_BIN"
[[ -f "$tmp/src/Copying.txt" ]] && cp "$tmp/src/Copying.txt" "$DEST_DIR/Copying.txt"
printf '%s\n%s\nsource sha256:%s\nbuilt %s\n' "$STOCKFISH_VERSION" "$BUILD_ID" \
  "${STOCKFISH_SRC_SHA256:-unverified}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEST_DIR/VERSION"
(echo uci; sleep 0.3) | "$DEST_BIN" 2>/dev/null | head -1 || true
echo "Installed $DEST_BIN ($STOCKFISH_VERSION, $STOCKFISH_BUILD_ARCH, $(du -h "$DEST_BIN" | cut -f1))"
