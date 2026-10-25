#!/usr/bin/env bash
# shellcheck disable=SC2317,SC2054,SC2016
# (SC2317: functions run indirectly via trap/check; SC2054: commas belong to docker flags;
#  SC2016: single-quoted snippets get their values as `bash -c` arguments on purpose.)
# Smoke test of the community node image (docker/node.Dockerfile, M24-8).
#
# Usage: scripts/node-image-smoke.sh [--no-build] [--platform linux/amd64|linux/arm64]
# Env:   SMOKE_IMAGE   image to test (default daisychess-node:smoke-<arch>; built unless --no-build)
#        WITH_MAIA     build arg (default 1); 0 also makes the checks expect Maia disabled
#        JOBS          compile jobs inside the build (default 4; 0 = all CPUs)
#        GITHUB_TOKEN  optional, passed to the build as a secret (GitHub API rate limit)
#        SMOKE_KEEP=1  keep containers/network after the run (for debugging)
#
# Checks (each prints PASS/FAIL; exit status = number of failures, 0 = all passed):
#   image     non-root user, no exposed ports, HEALTHCHECK, ROLE=node, no token/hub URL baked in
#   offline   container with --network none, read-only root, cap_drop ALL: becomes healthy,
#             engines found (/health/detail), node.hello attempts against an unreachable HUB_URL
#             with growing backoff, token never logged, root filesystem not writable, clean
#             SIGTERM exit
#   link      node ↔ fake hub (scripts/node-smoke-hub.mjs) on a private docker network:
#             register, one Stockfish search (+ one Maia move when built WITH_MAIA=1)
#   tiny      the same against a 1-CPU / 512 MB container with MAIA=off (Maia reported disabled)
#   hub       real ROLE=hub container instead of the fake (M24-5/M24-6): skipped until the image
#             contains the hub's LinkServer — extend run_real_hub() then.
#
# Only touches what it creates: containers and the network carry a unique run id and are removed
# by id/name at exit. Nothing is published on the host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD=1
PLATFORM="linux/amd64"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --platform) PLATFORM="$2"; shift ;;
    -h|--help) sed -n '5,27p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
ARCH="${PLATFORM#linux/}"
IMAGE="${SMOKE_IMAGE:-daisychess-node:smoke-$ARCH}"
WITH_MAIA="${WITH_MAIA:-1}"
RUN_ID="dcsmoke-$(date +%s)-$$"
NET="$RUN_ID-net"
# A syntactically valid node token (dcn_<8 base32>_<32 base32>); not known to any real hub.
TOKEN="dcn_smoke234_$(node -e 'const a="abcdefghijklmnopqrstuvwxyz234567";process.stdout.write([...require("crypto").randomBytes(32)].map(b=>a[b&31]).join(""))')"

CONTAINERS=()
NET_CREATED=0
FAILURES=0
cleanup() {
  [[ "${SMOKE_KEEP:-0}" == 1 ]] && { echo "SMOKE_KEEP=1: leaving ${CONTAINERS[*]:-} $NET"; return; }
  for c in "${CONTAINERS[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  if [[ $NET_CREATED == 1 ]]; then docker network rm "$NET" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILURES=$((FAILURES + 1)); }
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }
section() { echo; echo "== $* =="; }

# Hardened run options shared by every node container (mirror docker/docker-compose.node.yml).
HARDEN=(--read-only --tmpfs /tmp:size=64m,mode=1777 --cap-drop ALL
        --security-opt no-new-privileges:true --pids-limit 512)

wait_healthy() { # container timeout-s
  local i status
  for ((i = 0; i < $2; i++)); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.Running}}' "$1")"
    [[ "$status" == healthy\|* ]] && return 0
    [[ "$status" == *\|false ]] && { echo "container $1 exited"; return 1; }
    sleep 1
  done
  echo "container $1 not healthy after $2 s (status ${status%|*})"
  return 1
}
detail() { # container
  docker exec "$1" node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8580)+'/health/detail').then(r=>r.text()).then(t=>process.stdout.write(t))"
}
json() { # json-string js-expression-on-d
  node -e "const d=JSON.parse(process.argv[1]);const v=($2);process.stdout.write(typeof v==='string'?v:JSON.stringify(v))" "$1"
}

# ---- build ------------------------------------------------------------------------------------
if [[ $BUILD == 1 ]]; then
  section "build $IMAGE ($PLATFORM, WITH_MAIA=$WITH_MAIA)"
  secret=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && secret=(--secret id=github_token,env=GITHUB_TOKEN)
  start=$(date +%s)
  # Bounded compile parallelism inside the build (the daemon compiles, so `nice` on this client
  # would not help): build hosts are often shared. JOBS=0 = all CPUs.
  jobs="${JOBS:-4}"; [[ "$jobs" == 0 ]] && jobs=""
  docker build --platform "$PLATFORM" -f "$ROOT/docker/node.Dockerfile" \
    --build-arg WITH_MAIA="$WITH_MAIA" --build-arg JOBS="$jobs" "${secret[@]}" -t "$IMAGE" "$ROOT"
  echo "build time: $(( $(date +%s) - start )) s"
fi
docker image inspect "$IMAGE" >/dev/null || { echo "image $IMAGE not found" >&2; exit 1; }
size_mb=$(( $(docker image inspect -f '{{.Size}}' "$IMAGE") / 1000000 ))
echo "image: $IMAGE, $size_mb MB, $(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$IMAGE")"

# ---- image metadata ---------------------------------------------------------------------------
section "image"
cfg="$(docker image inspect -f '{{json .Config}}' "$IMAGE")"
check "runs as non-root user ($(json "$cfg" 'd.User'))" \
  test "$(json "$cfg" 'd.User && !/^(0|root)(:|$)/.test(d.User) ? "ok" : "no"')" = ok
check "exposes no ports" test "$(json "$cfg" 'Object.keys(d.ExposedPorts??{}).length')" = 0
check "has a HEALTHCHECK on /health" test "$(json "$cfg" 'JSON.stringify(d.Healthcheck?.Test??[]).includes("/health") ? "ok" : "no"')" = ok
check "ROLE=node in the image env" test "$(json "$cfg" '(d.Env??[]).includes("ROLE=node") ? "ok" : "no"')" = ok
check "no NODE_TOKEN / HUB_URL / GITHUB_TOKEN baked into the env" \
  test "$(json "$cfg" '(d.Env??[]).some(e=>/^(NODE_TOKEN|HUB_URL|GITHUB_TOKEN|ACCESS_TOKEN)=/.test(e)) ? "baked" : "clean"')" = clean
check "no .env or sqlite files in the image" \
  test -z "$(docker run --rm --network none --entrypoint sh "$IMAGE" -c 'find /app -name ".env*" -o -name "*.sqlite*" 2>/dev/null')"

# ---- offline: unreachable hub ------------------------------------------------------------------
section "offline (unreachable HUB_URL, --network none)"
off="$RUN_ID-offline"
docker run -d --name "$off" --network none "${HARDEN[@]}" \
  -e HUB_URL=wss://127.0.0.1:9/link -e NODE_TOKEN="$TOKEN" -e NODE_NAME=smoke \
  -e MAX_SESSIONS=2 -e MAX_THREADS=1 -e MAX_HASH_MB=64 "$IMAGE" >/dev/null
CONTAINERS+=("$off")
check "becomes healthy" wait_healthy "$off" 60
d="$(detail "$off" || echo '{}')"
check "/health/detail: role node" test "$(json "$d" 'd.role')" = node
check "/health/detail: stockfish enabled, not degraded" \
  test "$(json "$d" '(d.engines??[]).some(e=>e.id==="stockfish"&&e.enabled&&!e.degraded) ? "ok" : "no"')" = ok
maia_state="$(json "$d" '(()=>{const m=(d.engines??[]).filter(e=>e.id.startsWith("maia-"));return m.length===0?"none":m.every(e=>e.enabled)?"on":m.some(e=>e.enabled)?"partial":"off"})()')"
if [[ "$WITH_MAIA" == 1 ]]; then
  check "/health/detail: 9 maia engines enabled ($maia_state)" test "$maia_state" = on
else
  check "/health/detail: maia disabled in a WITH_MAIA=0 image ($maia_state)" test "$maia_state" = off
fi
check "/health/detail: link not connected" test "$(json "$d" 'String(d.link?.connected)')" = false
check "engine binaries answer UCI inside the container" docker exec "$off" sh -c \
  "(printf 'uci\nisready\nposition startpos\ngo depth 6\n'; sleep 2; echo quit) | /app/engines/stockfish/stockfish | grep -q '^bestmove'"
if [[ "$WITH_MAIA" == 1 ]]; then
  check "lc0 + maia-1500 return a move at 1 node" docker exec "$off" sh -c \
    "(printf 'uci\nisready\nposition startpos\ngo nodes 1\n'; sleep 3; echo quit) | /app/engines/lc0/lc0 --weights=/app/engines/maia/maia-1500.pb.gz --backend=eigen --threads=1 2>/dev/null | grep -q '^bestmove [a-h][1-8]'"
fi
check "root filesystem is read-only" docker exec "$off" sh -c '! touch /app/x 2>/dev/null && ! touch /x 2>/dev/null'
check "process runs as uid 10001" test "$(docker exec "$off" id -u)" = 10001
sleep 6   # backoff 1 s, 2 s, 4 s (±20 %): at least three attempts by now
logs="$(docker logs "$off" 2>&1)"
attempts=$(grep -c 'link: connecting to hub' <<<"$logs" || true)
check "node.hello attempts against the unreachable hub logged ($attempts)" test "$attempts" -ge 2
delays="$(grep 'reconnecting after backoff' <<<"$logs" | sed -n 's/.*"delayMs":\([0-9]*\).*/\1/p' | tr '\n' ' ')"
check "reconnect backoff grows ($delays)" node -e '
  const d=process.argv[1].trim().split(/\s+/).map(Number);
  process.exit(d.length>=2 && d.every((v,i)=>i===0||v>d[i-1]) ? 0 : 1)' "$delays"
check "token never appears in the logs" bash -c '! grep -qF "$1" <<<"$2"' _ "$TOKEN" "$logs"
grep -E 'daisychess-node:|engine node configured' <<<"$logs" | head -4 | cut -c1-300
start=$(date +%s)
docker stop -t 30 "$off" >/dev/null
code="$(docker inspect -f '{{.State.ExitCode}}' "$off")"
check "SIGTERM: clean exit ($code) within $(( $(date +%s) - start )) s" test "$code" = 0

# ---- link: node against the fake hub -----------------------------------------------------------
docker network create --internal "$NET" >/dev/null && NET_CREATED=1
run_fake_hub() { # label expect-maia node-docker-args...
  local label="$1" expect="$2"; shift 2
  local hub="$RUN_ID-hub-$label" node="$RUN_ID-node-$label"
  docker run -d --name "$hub" --network "$NET" --network-alias "hub-$label" "${HARDEN[@]}" \
    -v "$ROOT/scripts/node-smoke-hub.mjs:/smoke/hub.mjs:ro" --entrypoint node \
    -e SMOKE_NODE_TOKEN="$TOKEN" -e SMOKE_EXPECT_MAIA="$expect" -e SMOKE_TIMEOUT_MS=120000 \
    "$IMAGE" /smoke/hub.mjs >/dev/null
  CONTAINERS+=("$hub")
  docker run -d --name "$node" --network "$NET" "${HARDEN[@]}" "$@" \
    -e HUB_URL="ws://hub-$label:9000/link" -e DAISYCHESS_INSECURE=1 -e NODE_TOKEN="$TOKEN" \
    -e NODE_NAME="smoke-$label" "$IMAGE" >/dev/null
  CONTAINERS+=("$node")
  local code
  code="$(timeout 150 docker wait "$hub" || echo timeout)"
  docker logs "$hub" 2>&1 | grep -E '"msg":"(node.hello|search done|PASS|FAIL|node error)"' | cut -c1-400
  if [[ "$code" != 0 ]]; then
    echo "--- node logs ($node) ---"; docker logs "$node" 2>&1 | tail -30
  fi
  check "$label: register + search via the link (fake hub exit $code)" test "$code" = 0
  check "$label: node logged 'registered with the hub'" \
    bash -c 'docker logs "$1" 2>&1 | grep -q "link: registered with the hub"' _ "$node"
}

section "link (fake hub, private network)"
run_fake_hub full "$WITH_MAIA" -e MAX_SESSIONS=2 -e MAX_THREADS=2 -e MAX_HASH_MB=64

section "tiny (1 CPU, 512 MB, MAIA=off)"
run_fake_hub tiny 0 --cpus 1 --memory 512m -e MAIA=off -e MAX_SESSIONS=1 -e MAX_THREADS=1 -e MAX_HASH_MB=32

# ---- hub: the real ROLE=hub (later) ------------------------------------------------------------
section "hub (real ROLE=hub link server)"
run_real_hub() {
  # Extension point for M24-5/M24-6: start "$IMAGE" with ROLE=hub on "$NET" (HUB_STORE_PATH on a
  # tmpfs), create a node token through the hub's store/portal API, point a node at
  # ws://<hub>:<port>/link with DAISYCHESS_INSECURE=1 and run one search through the hub's player
  # /ws with a dc1_ token. Until then this function is not called.
  return 0
}
if docker run --rm --network none --entrypoint sh "$IMAGE" -c 'test -f /app/server/dist/hub/LinkServer.js'; then
  echo "SKIP  the image contains hub/LinkServer.js, but run_real_hub() is not written yet (extend this script)"
else
  echo "SKIP  ROLE=hub link server not in this build yet (M24-5); the fake hub covered the link"
fi

echo
if [[ $FAILURES -eq 0 ]]; then echo "node image smoke test: all checks passed ($IMAGE, $size_mb MB)"
else echo "node image smoke test: $FAILURES check(s) FAILED ($IMAGE)"; fi
exit "$FAILURES"
