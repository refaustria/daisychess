#!/usr/bin/env bash
# Elo fallback calibration (ADR-024 §5, deploy/README.md "Elo calibration").
#
# 1. Fetches lichess's standard/sha256sums.txt and downloads one monthly standard rated dump
#    (lichess_db_standard_rated_YYYY-MM.pgn.zst) into the cache:
#    - full (default): resumable (`curl -C -`), verified fail-closed against the listed digest
#      on every run (cached copies too; a mismatch deletes or marks the file stale);
#    - --range BYTES: only the first BYTES (ranged download, resumable). The digest of a prefix
#      cannot be checked; the listed digest of the whole dump is recorded in SOURCE.md, and a
#      cached prefix whose dump digest changed is discarded.
# 2. Builds engine-core and runs apps/web/scripts/calibrate-elo.mjs, which writes
#    apps/web/src/review/data/eloCalibration.json and SOURCE.md.
# 3. Prints the next step: commit eloCalibration.json + SOURCE.md and redeploy the web app.
# Installs nothing on the host; needs curl, sha256sum, node (zstd CLI only on Node < 22.15).
#
# Usage: deploy/calibrate-elo.sh [--month YYYY-MM] [--range BYTES] [--limit GAMES] [--dry-run]
#                                [--no-install]
#   --month YYYY-MM  dump month (default: the month before the current one)
#   --range BYTES    ranged partial download of the first BYTES (e.g. 2000000000 ≈ 2 GB)
#   --limit GAMES    stop after this many evaluated, eligible games
#   --dry-run        download/verify and calibrate, print the table; writes nothing in the repo
#   --no-install     skip `pnpm install --frozen-lockfile` (the engine-core build still runs)
#
# Environment (all optional):
#   PUZZLE_CACHE_DIR       download cache, shared with the puzzle pipeline
#                          (default ~/.cache/daisychess/puzzles)
#   ELO_CALIBRATION_OUT    output (default apps/web/src/review/data/eloCalibration.json)
#   LICHESS_DB_BASE_URL    dump directory (default https://database.lichess.org/standard)
#   LICHESS_DB_SUMS_URL    digest list (default $LICHESS_DB_BASE_URL/sha256sums.txt)
#   CALIBRATE_JOBS         worker threads (default: cores − 1, at most 8)
#   CALIBRATE_MIN_SAMPLES  samples a speed class needs to get its own curve (default 1000)
#   FREE_SPACE_MARGIN_MB   free disk space kept after the download (default 2048)
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }

MONTH=""
RANGE=""
LIMIT=""
DRY_RUN=0
INSTALL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --month)
      MONTH="${2:-}"
      shift
      [[ "$MONTH" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]] || { echo "error: --month needs YYYY-MM" >&2; exit 2; }
      ;;
    --range)
      RANGE="${2:-}"
      shift
      [[ "$RANGE" =~ ^[1-9][0-9]*$ ]] || { echo "error: --range needs a byte count" >&2; exit 2; }
      ;;
    --limit)
      LIMIT="${2:-}"
      shift
      [[ "$LIMIT" =~ ^[1-9][0-9]*$ ]] || { echo "error: --limit needs a game count" >&2; exit 2; }
      ;;
    --dry-run) DRY_RUN=1 ;;
    --no-install) INSTALL=0 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "error: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ -z "$MONTH" ]]; then
  # The dump of a month is published in the first days of the next one.
  MONTH="$(date -u -d "$(date -u +%Y-%m-15) -1 month" +%Y-%m)"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${PUZZLE_CACHE_DIR:-$HOME/.cache/daisychess/puzzles}"
OUT="${ELO_CALIBRATION_OUT:-$REPO_ROOT/apps/web/src/review/data/eloCalibration.json}"
BASE_URL="${LICHESS_DB_BASE_URL:-https://database.lichess.org/standard}"
SUMS_URL="${LICHESS_DB_SUMS_URL:-$BASE_URL/sha256sums.txt}"
MARGIN_MB="${FREE_SPACE_MARGIN_MB:-2048}"
DUMP_NAME="lichess_db_standard_rated_${MONTH}.pgn.zst"
DUMP_URL="$BASE_URL/$DUMP_NAME"

[[ "$MARGIN_MB" =~ ^[0-9]+$ ]] || { echo "error: FREE_SPACE_MARGIN_MB must be a number" >&2; exit 1; }
for tool in curl sha256sum node pnpm df; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found" >&2; exit 1; }
done

mkdir -p "$CACHE_DIR"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/daisychess-elo.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

CURL=(curl -fsSL --proto '=https,file' --retry 3 --retry-delay 5 --connect-timeout 30)

# --- 1: digest, download, verify ------------------------------------------------------------------
"${CURL[@]}" -o "$WORK/sha256sums.txt" "$SUMS_URL"
# `<hex>  <name>` or `<hex> *<name>`; exactly one entry for the dump.
mapfile -t found < <(awk -v n="$DUMP_NAME" '($2 == n || $2 == "*" n) && $1 ~ /^[0-9a-fA-F]{64}$/ { print tolower($1) }' "$WORK/sha256sums.txt")
if [[ ${#found[@]} -ne 1 ]]; then
  echo "error: $SUMS_URL lists ${#found[@]} digests for $DUMP_NAME (expected exactly one; is the month published?)" >&2
  exit 1
fi
EXPECTED="${found[0]}"
echo "lichess lists $DUMP_NAME as $EXPECTED"

file_size() { stat -c %s "$1" 2>/dev/null || echo 0; }

# Fails when downloading $1 more bytes would leave less than the margin free.
need_space() {
  local avail_kb
  avail_kb="$(df -Pk "$CACHE_DIR" | awk 'NR == 2 { print $4 }')"
  if (( avail_kb / 1024 < $1 / 1048576 + MARGIN_MB )); then
    echo "error: $(( $1 / 1048576 )) MB to download but only $(( avail_kb / 1024 )) MB free in $CACHE_DIR (margin ${MARGIN_MB} MB); use --range or free space" >&2
    exit 1
  fi
}

# The dump size from the server (0 when unknown, e.g. file:// without a length).
remote_size() {
  "${CURL[@]}" -I "$DUMP_URL" 2>/dev/null | tr -d '\r' |
    sed -n 's/^[Cc]ontent-[Ll]ength: *//p' | tail -n 1 | grep -E '^[0-9]+$' || echo 0
}

args=(--month "$MONTH" --source "$DUMP_URL")
if [[ -n "$RANGE" ]]; then
  INPUT="$CACHE_DIR/range-$RANGE-$DUMP_NAME"
  # A prefix of another dump version (re-published month) must not be reused or extended.
  if [[ -f "$INPUT.dump-sha256" && "$(cat "$INPUT.dump-sha256")" != "$EXPECTED" ]]; then
    echo "Cached prefix belongs to another version of the dump: discarded"
    rm -f "$INPUT" "$INPUT.dump-sha256"
  fi
  have="$(file_size "$INPUT")"
  if (( have > RANGE )); then rm -f "$INPUT"; have=0; fi
  if (( have < RANGE )); then
    need_space $(( RANGE - have ))
    echo "$EXPECTED" >"$INPUT.dump-sha256"
    echo "Ranged download of bytes $have-$((RANGE - 1)) of $DUMP_URL (resumable)"
    "${CURL[@]}" -r "$have-$((RANGE - 1))" "$DUMP_URL" >>"$INPUT"
    have="$(file_size "$INPUT")"
    # A server that ignores the range sends the whole file: refuse instead of using it.
    if (( have != RANGE )); then
      rm -f "$INPUT" "$INPUT.dump-sha256"
      echo "error: ranged download gave $have bytes, expected $RANGE (deleted; run again)" >&2
      exit 1
    fi
  else
    echo "Cached prefix is complete ($INPUT)"
  fi
  args+=(--input "$INPUT" --sample "$RANGE" --dump-sha256 "$EXPECTED")
else
  INPUT="$CACHE_DIR/$DUMP_NAME"
  if [[ -s "$INPUT" && -f "$INPUT.sha256" && "$(cat "$INPUT.sha256")" == "$EXPECTED" ]]; then
    echo "Cached dump is current ($INPUT)"
  else
    # A partial download of another dump version must not be resumed into this one.
    if [[ -f "$INPUT.part" && "$(cat "$INPUT.part.sha256" 2>/dev/null)" != "$EXPECTED" ]]; then
      rm -f "$INPUT.part"
    fi
    total="$(remote_size)"
    if (( total > 0 )); then need_space $(( total - $(file_size "$INPUT.part") )); fi
    echo "$EXPECTED" >"$INPUT.part.sha256"
    echo "Downloading $DUMP_URL (resumable)"
    "${CURL[@]}" -C - -o "$INPUT.part" "$DUMP_URL"
    actual="$(sha256sum "$INPUT.part" | cut -d' ' -f1)"
    if [[ "$actual" != "$EXPECTED" ]]; then
      rm -f "$INPUT.part" "$INPUT.part.sha256"
      echo "error: downloaded $DUMP_NAME has sha256 $actual, expected $EXPECTED (deleted; run again)" >&2
      exit 1
    fi
    mv "$INPUT.part" "$INPUT"
    rm -f "$INPUT.part.sha256"
    echo "$EXPECTED" >"$INPUT.sha256"
  fi
  # Fail closed on every run, also for a cached file (the script verifies once more).
  actual="$(sha256sum "$INPUT" | cut -d' ' -f1)"
  if [[ "$actual" != "$EXPECTED" ]]; then
    rm -f "$INPUT.sha256"
    echo "error: cached $INPUT has sha256 $actual, expected $EXPECTED (marked stale; run again)" >&2
    exit 1
  fi
  args+=(--input "$INPUT" --sha256 "$EXPECTED")
fi

# --- 2: calibrate ---------------------------------------------------------------------------------
cd "$REPO_ROOT"
if [[ $INSTALL -eq 1 ]]; then pnpm install --frozen-lockfile; fi
# ELO_SKIP_BUILD=1 is for the script's own test (the package is built before the tests).
if [[ "${ELO_SKIP_BUILD:-}" != 1 ]]; then pnpm --filter @daisychess/engine-core build; fi

[[ -n "$LIMIT" ]] && args+=(--limit "$LIMIT")
[[ -n "${CALIBRATE_JOBS:-}" ]] && args+=(--jobs "$CALIBRATE_JOBS")
[[ -n "${CALIBRATE_MIN_SAMPLES:-}" ]] && args+=(--min-samples "$CALIBRATE_MIN_SAMPLES")
if [[ $DRY_RUN -eq 1 ]]; then
  args+=(--dry-run)
else
  args+=(--out "$WORK/out/eloCalibration.json")
fi
node --max-old-space-size=2048 apps/web/scripts/calibrate-elo.mjs "${args[@]}"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "Dry run: nothing written outside $CACHE_DIR"
  exit 0
fi

mkdir -p "$(dirname "$OUT")"
cp "$WORK/out/eloCalibration.json" "$OUT"
cp "$WORK/out/SOURCE.md" "$(dirname "$OUT")/SOURCE.md"
echo "Wrote $OUT (+ SOURCE.md)"

cat <<EOF

Next steps:
  1. Review and commit eloCalibration.json + SOURCE.md:
       git add apps/web/src/review/data/eloCalibration.json apps/web/src/review/data/SOURCE.md
       git commit -m "chore(web): Elo fallback calibration from the lichess $MONTH dump"
  2. Redeploy the web app: deploy/deploy-web.sh
EOF
