#!/usr/bin/env bash
# Builds Lc0 (Leela Chess Zero) for the engine server into engines/lc0/lc0 (ADR-019).
#
# CPU-only build for a host WITHOUT AVX2 (ADR-003): Eigen BLAS backend (header-only, no runtime
# BLAS library), portable SSE4.2 + POPCNT code generation, no F16C/PEXT/AVX, no GPU backends.
# Used for the Maia "human-like" nets (scripts/fetch-maia.sh) at 1 node per move.
#
# Usage: scripts/build-lc0.sh [--force] [--no-verify]
# Env:   LC0_VERSION           release tag (default v0.32.1); other tags need LC0_SHA256 and
#                              LCZERO_COMMON_COMMIT/LCZERO_COMMON_SHA256 (or --no-verify)
#        LC0_SHA256            sha256 of the lc0 source tarball (pinned for the default tag)
#        LCZERO_COMMON_COMMIT  commit of the lczero-common submodule (protobuf definitions)
#        LCZERO_COMMON_SHA256  sha256 of its tarball
#        LC0_NATIVE_ARCH=1     -march=native instead of the portable SSE4.2/POPCNT baseline
#        LC0_F16C=1            enable F16C (needs a CPU with f16c; the production VM has none)
#        LC0_JOBS              parallel compile jobs (default: nproc)
#
# Build dependencies (Debian/Ubuntu): sudo apt-get install meson ninja-build g++ python3 \
#   pkg-config zlib1g-dev libeigen3-dev
# Network: the two source tarballs (sha256-verified here) and the abseil-cpp subproject, which
# meson downloads from its wrap file (hash-verified by meson). Idempotent: skips when the
# installed binary was built from the same tag with the same flags (--force rebuilds).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINES_DIR="$ROOT/engines"
DEST_DIR="$ENGINES_DIR/lc0"
DEST_BIN="$DEST_DIR/lc0"

LC0_VERSION="${LC0_VERSION:-v0.32.1}"
# Pinned digests (recorded 2026-10-25 from github.com/LeelaChessZero releases/archives).
if [[ "$LC0_VERSION" == "v0.32.1" ]]; then
  : "${LC0_SHA256:=78b17e8e8d29da30492c86fdac69c519816f4a9d9c3b787dc41a6f9e8d20fde3}"
  : "${LCZERO_COMMON_COMMIT:=b326b154221a6eb91977bdccf11d6f89e8547875}"
  : "${LCZERO_COMMON_SHA256:=d12ec2257c0412a8962c0c439170ce98c6001ab6be6a6444a849d0115bfb330a}"
fi
LC0_SHA256="${LC0_SHA256:-}"
LCZERO_COMMON_COMMIT="${LCZERO_COMMON_COMMIT:-}"
LCZERO_COMMON_SHA256="${LCZERO_COMMON_SHA256:-}"

FORCE=0
VERIFY=1
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    --no-verify) VERIFY=0 ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 0 ;;
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

# Code generation: portable baseline of ADR-003 unless the operator asks for the native arch.
if [[ "${LC0_NATIVE_ARCH:-0}" == 1 ]]; then
  NATIVE_ARCH=true; ARCH_FLAGS=""
else
  NATIVE_ARCH=false; ARCH_FLAGS="-msse4.2 -mpopcnt"
fi
F16C=false
[[ "${LC0_F16C:-0}" == 1 ]] && F16C=true
FLAGS_ID="eigen native_arch=$NATIVE_ARCH f16c=$F16C arch_flags=${ARCH_FLAGS:-none}"

if [[ -x "$DEST_BIN" && $FORCE -eq 0 && -f "$DEST_DIR/VERSION" ]]; then
  if [[ "$(sed -n 1p "$DEST_DIR/VERSION")" == "$LC0_VERSION" && "$(sed -n 4p "$DEST_DIR/VERSION")" == "$FLAGS_ID" ]]; then
    echo "Lc0 $LC0_VERSION already present at $DEST_BIN (use --force to rebuild)"
    exit 0
  fi
  echo "Lc0 at $DEST_BIN was built from another version/flags; rebuilding"
fi

# ---- dependencies --------------------------------------------------------------------
for tool in curl tar meson ninja g++ python3 pkg-config; do
  command -v "$tool" >/dev/null || die "missing build tool: $tool (sudo apt-get install meson ninja-build g++ python3 pkg-config)"
done
pkg-config --exists zlib || die "zlib development files missing (sudo apt-get install zlib1g-dev)"
pkg-config --exists eigen3 || die "Eigen 3 headers missing (sudo apt-get install libeigen3-dev)"
EIGEN_CFLAGS="$(pkg-config --cflags eigen3)"

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null; then openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else echo ""; fi
}
verify() { # file expected-digest label
  if [[ -z "$2" ]]; then unverified "no pinned sha256 for $3"; return; fi
  local actual; actual="$(sha256_of "$1")"
  [[ -n "$actual" ]] || { unverified "no sha256 tool found to verify $3"; return; }
  [[ "$actual" == "$2" ]] || die "checksum mismatch for $3: expected $2, got $actual"
  echo "sha256 verified for $3 ($2)"
}

# ---- download + verify ---------------------------------------------------------------
[[ -n "$LCZERO_COMMON_COMMIT" ]] || die "LCZERO_COMMON_COMMIT must be set for LC0_VERSION=$LC0_VERSION"
mkdir -p "$ENGINES_DIR/.tmp"
tmp="$(mktemp -d "$ENGINES_DIR/.tmp/lc0.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

LC0_URL="https://github.com/LeelaChessZero/lc0/archive/refs/tags/$LC0_VERSION.tar.gz"
COMMON_URL="https://github.com/LeelaChessZero/lczero-common/archive/$LCZERO_COMMON_COMMIT.tar.gz"
echo "Downloading $LC0_URL"
curl -fSL --progress-bar -o "$tmp/lc0.tar.gz" "$LC0_URL"
verify "$tmp/lc0.tar.gz" "$LC0_SHA256" "lc0 $LC0_VERSION source"
echo "Downloading $COMMON_URL"
curl -fSL --progress-bar -o "$tmp/lczero-common.tar.gz" "$COMMON_URL"
verify "$tmp/lczero-common.tar.gz" "$LCZERO_COMMON_SHA256" "lczero-common $LCZERO_COMMON_COMMIT"

mkdir -p "$tmp/src"
tar -xzf "$tmp/lc0.tar.gz" -C "$tmp/src" --strip-components=1
mkdir -p "$tmp/src/libs/lczero-common"
tar -xzf "$tmp/lczero-common.tar.gz" -C "$tmp/src/libs/lczero-common" --strip-components=1
[[ -f "$tmp/src/libs/lczero-common/proto/net.proto" ]] || die "lczero-common tarball lacks proto/net.proto"
[[ -f "$tmp/src/meson.build" ]] || die "lc0 tarball lacks meson.build"

# ---- build ---------------------------------------------------------------------------
JOBS="${LC0_JOBS:-$(nproc 2>/dev/null || echo 4)}"
echo "Building Lc0 $LC0_VERSION ($FLAGS_ID) with $JOBS jobs"
start=$(date +%s)
meson setup "$tmp/build" "$tmp/src" --buildtype release \
  -Dgtest=false -Dlc0=true -Drescorer=false -Dpython_bindings=false \
  -Dblas=true -Dopenblas=false -Dmkl=false -Ddnnl=false -Daccelerate=false \
  -Dplain_cuda=false -Dcudnn=false -Donnx=false -Dopencl=false -Dtensorflow=false -Donednn=false \
  -Dnative_arch=$NATIVE_ARCH -Dpopcnt=true -Df16c=$F16C -Dpext=false \
  -Db_lto=true -Ddefault_backend=eigen \
  -Dcpp_args="$ARCH_FLAGS $EIGEN_CFLAGS" -Dc_args="$ARCH_FLAGS" \
  > "$tmp/meson-setup.log" 2>&1 || { cat "$tmp/meson-setup.log" >&2; die "meson setup failed"; }
grep -E "Run-time dependency eigen3|Downloading" "$tmp/meson-setup.log" || true
ninja -C "$tmp/build" -j "$JOBS" lc0 > "$tmp/ninja.log" 2>&1 || { tail -50 "$tmp/ninja.log" >&2; die "ninja build failed"; }
echo "Build finished in $(( $(date +%s) - start )) s"
[[ -x "$tmp/build/lc0" ]] || die "build produced no lc0 binary"

# ---- install -------------------------------------------------------------------------
mkdir -p "$DEST_DIR"
install -m 0755 "$tmp/build/lc0" "$DEST_BIN.new"
mv -f "$DEST_BIN.new" "$DEST_BIN"
[[ -f "$tmp/src/COPYING" ]] && cp "$tmp/src/COPYING" "$DEST_DIR/COPYING"
printf '%s\nlc0 sha256:%s\nlczero-common %s sha256:%s\n%s\nbuilt %s\n' \
  "$LC0_VERSION" "${LC0_SHA256:-unverified}" "$LCZERO_COMMON_COMMIT" "${LCZERO_COMMON_SHA256:-unverified}" \
  "$FLAGS_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEST_DIR/VERSION"

# ---- smoke test ----------------------------------------------------------------------
"$DEST_BIN" --help 2>/dev/null | grep -q -- '--backend=' || die "smoke test failed: $DEST_BIN --help"
weights="$ENGINES_DIR/maia/maia-1500.pb.gz"
if [[ -r "$weights" ]]; then
  out="$( (printf 'uci\nsetoption name VerboseMoveStats value true\nisready\nposition startpos\ngo nodes 1\n'; sleep 2; echo quit) \
    | "$DEST_BIN" --weights="$weights" --backend=eigen --threads=1 --minibatch-size=1 2>/dev/null )"
  if ! { grep -q '^uciok' <<<"$out" && grep -q '^readyok' <<<"$out" && grep -q '^bestmove [a-h][1-8][a-h][1-8]' <<<"$out"; }; then
    echo "smoke test with $weights failed:" >&2; echo "$out" >&2; exit 1
  fi
  echo "UCI smoke test with Maia 1500 at 1 node: $(grep '^bestmove' <<<"$out")"
else
  echo "note: $weights not present; run scripts/fetch-maia.sh for the UCI smoke test"
fi
echo "Installed $DEST_BIN ($LC0_VERSION, $(du -h "$DEST_BIN" | cut -f1))"
