#!/usr/bin/env bash
# Endgame tables for https://play.daisychess.org/endgames/v1/ (ADR-025 §2, deploy/README.md "Endgame tables").
#
# 1. Builds @daisychess/endgames and downloads the rook pack (KRPvKR WDL, ~16 MB) with
#    packages/endgames/scripts/fetch-tables.mjs --pack rook into the cache dir (resumable).
# 2. Verifies every file of the manifest (core files from apps/web/public/endgames/v1/, rook files
#    from the cache) against packages/endgames/tables.manifest.json: size and sha256, fail-closed.
# 3. rsyncs core + rook files into $ENDGAME_ROOT WITHOUT --delete.
#
# Usage: deploy/deploy-endgames.sh [--dry-run] [--no-install]
#   --dry-run     download and verify, print what would be published, write nothing to $ENDGAME_ROOT
#   --no-install  skip `pnpm install --frozen-lockfile` (the package build still runs)
#
# Environment (all optional):
#   ENDGAME_CACHE_DIR  download cache (default ~/.cache/daisychess/endgames)
#   ENDGAME_ROOT       publish target (default /var/www/play.daisychess.org/endgames/v1)
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }

DRY_RUN=0
INSTALL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-install) INSTALL=0 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "error: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${ENDGAME_CACHE_DIR:-$HOME/.cache/daisychess/endgames}"
ENDGAME_ROOT="${ENDGAME_ROOT:-/var/www/play.daisychess.org/endgames/v1}"
CORE_DIR="$REPO_ROOT/apps/web/public/endgames/v1"
MANIFEST="$REPO_ROOT/packages/endgames/tables.manifest.json"
FETCH="$REPO_ROOT/packages/endgames/scripts/fetch-tables.mjs"

for tool in sha256sum rsync node pnpm; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found" >&2; exit 1; }
done
[[ -f "$MANIFEST" && -f "$FETCH" ]] || { echo "error: packages/endgames is missing (manifest or fetch-tables.mjs)" >&2; exit 1; }

cd "$REPO_ROOT"
mkdir -p "$CACHE_DIR"
if [[ $INSTALL == 1 ]]; then pnpm install --frozen-lockfile; fi
pnpm --filter @daisychess/endgames build

# Download the rook pack (the script verifies each sha256 and refuses a mismatch).
node "$FETCH" --pack rook --out "$CACHE_DIR"

# Independent verification of everything that will be published: "<pack> <file> <bytes> <sha256>".
WORK="$(mktemp -d "${TMPDIR:-/tmp}/daisychess-endgames.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (m.format !== 1 || !Array.isArray(m.tables)) { console.error("error: unsupported manifest"); process.exit(1); }
for (const t of m.tables) {
  if (!/^[A-Za-z0-9]+$/.test(t.name) || !["wdl", "dtz"].includes(t.kind) || !["core", "rook"].includes(t.pack)) {
    console.error("error: bad manifest entry " + JSON.stringify(t)); process.exit(1);
  }
  console.log([t.pack, t.name + (t.kind === "wdl" ? ".rtbw" : ".rtbz"), t.bytes, t.sha256].join(" "));
}' "$MANIFEST" >"$WORK/files.txt"

STAGE="$WORK/stage"
mkdir -p "$STAGE"
count=0
while read -r pack file bytes sha; do
  if [[ "$pack" == core ]]; then src="$CORE_DIR/$file"; else src="$CACHE_DIR/$file"; fi
  [[ -f "$src" ]] || { echo "error: $file ($pack pack) not found at $src" >&2; exit 1; }
  [[ "$(stat -c %s "$src")" == "$bytes" ]] || { echo "error: $file has the wrong size (manifest: $bytes)" >&2; exit 1; }
  [[ "$(sha256sum "$src" | cut -d' ' -f1)" == "$sha" ]] || { echo "error: $file does not match the manifest sha256" >&2; exit 1; }
  ln -s "$src" "$STAGE/$file"
  count=$((count + 1))
done <"$WORK/files.txt"
echo "Verified $count table files against the manifest"

if [[ $DRY_RUN == 1 ]]; then
  echo "Dry run: would rsync to $ENDGAME_ROOT (no --delete):"
  ls -l "$STAGE" | sed 's/^/  /'
  exit 0
fi

mkdir -p "$ENDGAME_ROOT"
rsync -aL --chmod=D755,F644 "$STAGE"/ "$ENDGAME_ROOT"/
echo "Published $count files to $ENDGAME_ROOT"

cat <<EOT

Next steps:
  1. Check: curl -sI -H 'Origin: https://app.daisychess.org' https://play.daisychess.org/endgames/v1/KRPvKR.rtbw
  2. deploy/deploy-web.sh excludes /endgames/ from its --delete, so web deploys keep the rook pack.
EOT
