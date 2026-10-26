#!/usr/bin/env bash
# Puzzle data for https://play.daisychess.org/puzzles/v1/ (ADR-023 §4, deploy/README.md "Puzzle data").
#
# 1. Fetches lichess's sha256sums.txt and downloads lichess_db_puzzle.csv.zst into the cache only
#    when it is missing or the listed digest changed (`curl -C -` resumes a partial download).
# 2. Verifies the dump fail-closed against that digest (and LICHESS_PUZZLE_SHA256 when set).
# 3. Builds the shards, index.json and the starter set with packages/puzzles/scripts/build-puzzles.mjs
#    into a temp directory (the starter + SOURCE.md go to apps/web/src/puzzles/data/).
# 4. rsyncs the shards first and index.json last into $PUZZLE_ROOT, WITHOUT --delete (clients
#    with a cached index keep resolving old shards), then prunes shards that the new index does
#    not name and that have been unreferenced for more than $PUZZLE_PRUNE_DAYS days.
#
# Usage: deploy/deploy-puzzles.sh [--dry-run] [--sample BYTES] [--no-install]
#   --dry-run       download/verify and build, print the counts; writes nothing outside the cache
#   --sample BYTES  ranged download of the first BYTES of the dump (development, initial starter);
#                   no digest can be verified, nothing is published, the starter is still written
#   --no-install    skip `pnpm install --frozen-lockfile` (the package build still runs)
#
# Environment (all optional):
#   PUZZLE_CACHE_DIR       download cache (default ~/.cache/daisychess/puzzles)
#   PUZZLE_ROOT            publish target (default /var/www/play.daisychess.org/puzzles/v1)
#   PUZZLE_STARTER         starter path (default apps/web/src/puzzles/data/starter.json)
#   LICHESS_PUZZLE_URL     dump URL (default https://database.lichess.org/lichess_db_puzzle.csv.zst)
#   LICHESS_SUMS_URL       digest list (default https://database.lichess.org/sha256sums.txt)
#   LICHESS_PUZZLE_SHA256  pin: the dump must also have exactly this digest
#   PUZZLE_PRUNE_DAYS      grace period of unreferenced shards (default 30)
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }

DRY_RUN=0
SAMPLE=""
INSTALL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --sample)
      SAMPLE="${2:-}"
      shift
      [[ "$SAMPLE" =~ ^[1-9][0-9]*$ ]] || { echo "error: --sample needs a byte count" >&2; exit 2; }
      ;;
    --no-install) INSTALL=0 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "error: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${PUZZLE_CACHE_DIR:-$HOME/.cache/daisychess/puzzles}"
PUZZLE_ROOT="${PUZZLE_ROOT:-/var/www/play.daisychess.org/puzzles/v1}"
STARTER="${PUZZLE_STARTER:-$REPO_ROOT/apps/web/src/puzzles/data/starter.json}"
DUMP_URL="${LICHESS_PUZZLE_URL:-https://database.lichess.org/lichess_db_puzzle.csv.zst}"
SUMS_URL="${LICHESS_SUMS_URL:-https://database.lichess.org/sha256sums.txt}"
PIN="${LICHESS_PUZZLE_SHA256:-}"
PRUNE_DAYS="${PUZZLE_PRUNE_DAYS:-30}"
DUMP_NAME="${DUMP_URL##*/}"

if [[ -n "$PIN" && ! "$PIN" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "error: LICHESS_PUZZLE_SHA256 is not a sha256 hex digest" >&2
  exit 1
fi
PIN="${PIN,,}"
[[ "$PRUNE_DAYS" =~ ^[0-9]+$ ]] || { echo "error: PUZZLE_PRUNE_DAYS must be a number" >&2; exit 1; }

for tool in curl sha256sum rsync node pnpm; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found" >&2; exit 1; }
done

mkdir -p "$CACHE_DIR"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/daisychess-puzzles.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

CURL=(curl -fsSL --proto '=https,file' --retry 3 --retry-delay 5 --connect-timeout 30)

# --- 1+2: download and verify ---------------------------------------------------------------------
LAST_MODIFIED=""
if [[ -n "$SAMPLE" ]]; then
  INPUT="$CACHE_DIR/sample-$SAMPLE-$DUMP_NAME"
  if [[ ! -s "$INPUT" ]]; then
    echo "Ranged download of the first $SAMPLE bytes of $DUMP_URL"
    "${CURL[@]}" -r "0-$((SAMPLE - 1))" -o "$INPUT.part" "$DUMP_URL"
    mv "$INPUT.part" "$INPUT"
  fi
  EXPECTED=""
else
  INPUT="$CACHE_DIR/$DUMP_NAME"
  "${CURL[@]}" -o "$WORK/sha256sums.txt" "$SUMS_URL"
  # `<hex>  <name>` or `<hex> *<name>`; exactly one entry for the dump.
  mapfile -t found < <(awk -v n="$DUMP_NAME" '($2 == n || $2 == "*" n) && $1 ~ /^[0-9a-fA-F]{64}$/ { print tolower($1) }' "$WORK/sha256sums.txt")
  if [[ ${#found[@]} -ne 1 ]]; then
    echo "error: $SUMS_URL lists ${#found[@]} digests for $DUMP_NAME (expected exactly one)" >&2
    exit 1
  fi
  EXPECTED="${found[0]}"
  if [[ -n "$PIN" && "$PIN" != "$EXPECTED" ]]; then
    echo "error: LICHESS_PUZZLE_SHA256 ($PIN) differs from $SUMS_URL ($EXPECTED)" >&2
    exit 1
  fi
  echo "lichess lists $DUMP_NAME as $EXPECTED"

  if [[ -s "$INPUT" && -f "$INPUT.sha256" && "$(cat "$INPUT.sha256")" == "$EXPECTED" ]]; then
    echo "Cached dump is current ($INPUT)"
  else
    # A partial download of an older dump must not be resumed into the new one.
    if [[ -f "$INPUT.part" && "$(cat "$INPUT.part.sha256" 2>/dev/null)" != "$EXPECTED" ]]; then
      rm -f "$INPUT.part"
    fi
    echo "$EXPECTED" >"$INPUT.part.sha256"
    echo "Downloading $DUMP_URL (resumable)"
    "${CURL[@]}" -C - -o "$INPUT.part" "$DUMP_URL"
    actual="$(sha256sum "$INPUT.part" | cut -d' ' -f1)"
    if [[ "$actual" != "$EXPECTED" ]]; then
      rm -f "$INPUT.part" "$INPUT.part.sha256"
      echo "error: downloaded $DUMP_NAME has sha256 $actual, expected $EXPECTED (deleted; run again)" >&2
      exit 1
    fi
    "${CURL[@]}" -I "$DUMP_URL" 2>/dev/null | tr -d '\r' |
      sed -n 's/^[Ll]ast-[Mm]odified: *//p' | tail -n 1 >"$INPUT.last-modified" || true
    mv "$INPUT.part" "$INPUT"
    rm -f "$INPUT.part.sha256"
    echo "$EXPECTED" >"$INPUT.sha256"
  fi
  # Fail closed on every run, also for a cached file.
  actual="$(sha256sum "$INPUT" | cut -d' ' -f1)"
  if [[ "$actual" != "$EXPECTED" ]]; then
    rm -f "$INPUT.sha256"
    echo "error: cached $INPUT has sha256 $actual, expected $EXPECTED (marked stale; run again)" >&2
    exit 1
  fi
  LAST_MODIFIED="$(cat "$INPUT.last-modified" 2>/dev/null || true)"
fi

# --- 3: build -------------------------------------------------------------------------------------
cd "$REPO_ROOT"
if [[ $INSTALL -eq 1 ]]; then pnpm install --frozen-lockfile; fi
# PUZZLES_SKIP_BUILD=1 is for the script's own test (the package is built before the tests).
if [[ "${PUZZLES_SKIP_BUILD:-}" != 1 ]]; then pnpm --filter @daisychess/puzzles build; fi

args=(--input "$INPUT" --out "$WORK/out" --source "$DUMP_URL")
[[ -n "$EXPECTED" ]] && args+=(--sha256 "$EXPECTED")
[[ -n "$LAST_MODIFIED" ]] && args+=(--last-modified "$LAST_MODIFIED")
[[ -n "$SAMPLE" ]] && args+=(--sample "$SAMPLE")
if [[ $DRY_RUN -eq 1 ]]; then
  args+=(--dry-run)
else
  args+=(--starter "$WORK/starter/starter.json")
fi
# The pipeline stays well under 2 GB (deploy/README.md); the heap cap makes a regression fail
# instead of pushing the host into swap.
node --max-old-space-size=2048 packages/puzzles/scripts/build-puzzles.mjs "${args[@]}"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "Dry run: nothing written outside $CACHE_DIR"
  exit 0
fi

mkdir -p "$(dirname "$STARTER")"
cp "$WORK/starter/starter.json" "$STARTER"
cp "$WORK/starter/SOURCE.md" "$(dirname "$STARTER")/SOURCE.md"
echo "Starter: $STARTER (+ SOURCE.md)"

if [[ -n "$SAMPLE" ]]; then
  echo "Sample build: not published. Shards were built in a temp dir and discarded."
  exit 0
fi

# --- 4: publish -----------------------------------------------------------------------------------
mkdir -p "$PUZZLE_ROOT/shards"
# Shards first (new names only; existing ones are content-addressed and unchanged), index last.
rsync -a --chmod=D755,F644 "$WORK/out/shards/" "$PUZZLE_ROOT/shards/"
rsync -a --chmod=F644 "$WORK/out/index.json" "$PUZZLE_ROOT/index.json"
echo "Published $(find "$WORK/out/shards" -name '*.json' | wc -l) shards + index.json to $PUZZLE_ROOT"

# Prune: a shard the index does not name is remembered with the time it was first seen
# unreferenced ($CACHE_DIR/unreferenced.txt, outside the web root) and deleted once that is more
# than PRUNE_DAYS days ago. A shard that is referenced again is forgotten.
STATE="$CACHE_DIR/unreferenced.txt"
touch "$STATE"
now="$(date +%s)"
grace=$((PRUNE_DAYS * 86400))
node -e '
  const idx = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const s of idx.shards) console.log(s.file.slice("shards/".length));
' "$PUZZLE_ROOT/index.json" | sort -u >"$WORK/referenced.txt"
find "$PUZZLE_ROOT/shards" -maxdepth 1 -type f -name '*.json' -printf '%f\n' | sort -u >"$WORK/present.txt"
comm -23 "$WORK/present.txt" "$WORK/referenced.txt" >"$WORK/unreferenced.txt"
pruned=0
: >"$WORK/state.new"
while IFS= read -r f; do
  since="$(awk -v f="$f" '$1 == f { print $2; exit }' "$STATE")"
  [[ "$since" =~ ^[0-9]+$ ]] || since="$now"
  if (( now - since > grace )); then
    rm -f -- "$PUZZLE_ROOT/shards/$f"
    pruned=$((pruned + 1))
  else
    echo "$f $since" >>"$WORK/state.new"
  fi
done <"$WORK/unreferenced.txt"
mv "$WORK/state.new" "$STATE"
echo "Unreferenced shards kept: $(wc -l <"$STATE"), pruned: $pruned (grace ${PRUNE_DAYS} days)"

cat <<EOF

Next steps:
  1. Review and commit the starter:
       git add apps/web/src/puzzles/data/starter.json apps/web/src/puzzles/data/SOURCE.md
       git commit -m "chore(web): puzzle starter from the lichess dump ${EXPECTED:0:12}"
  2. Redeploy the web app so it ships the new starter: deploy/deploy-web.sh
     (it excludes /puzzles/ from its --delete; the mobile apps get the starter with the next release)
  3. Check: curl -sI https://play.daisychess.org/puzzles/v1/index.json
EOF
