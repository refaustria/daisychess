#!/bin/sh
# Entry point of the DaisyChess node image (docker/node.Dockerfile, M24-8); runs under tini.
#
# 1. NODE_TOKEN_FILE: reads the node token from a file (Docker/compose secret) so it does not
#    have to sit in the container environment (`docker inspect` shows env, not secret files).
# 2. CPU report: reads /proc/cpuinfo, names the best Stockfish variant this CPU supports and the
#    one the universal binary actually selected (`compiler` command). The binary dispatches on
#    its own (sf_19 universal build), so this is diagnostics, not selection; a mismatch is
#    logged as a warning (e.g. a hypervisor that masks AVX2 in cpuinfo but not in CPUID).
# 3. Maia: an image built with WITH_MAIA=0 (or without the Lc0 binary) defaults to MAIA=off, so
#    the log says "disabled" instead of "binary missing". An explicit MAIA=... always wins.
# Then execs the command (default: node dist/index.js) as PID 2 under tini.
set -eu

log() { printf '%s daisychess-node: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# ---- 1. token from a secret file ----------------------------------------------------------
if [ -n "${NODE_TOKEN_FILE:-}" ]; then
  if [ ! -r "$NODE_TOKEN_FILE" ]; then
    log "error: NODE_TOKEN_FILE=$NODE_TOKEN_FILE is not readable"
    exit 2
  fi
  NODE_TOKEN="$(tr -d ' \r\n\t' < "$NODE_TOKEN_FILE")"
  export NODE_TOKEN
fi
unset NODE_TOKEN_FILE

# ---- 2. CPU report ------------------------------------------------------------------------
best_variant() {
  case "$(uname -m)" in
    x86_64)
      # Mirrors the dispatch of Stockfish's universal/entry_x86.cpp (Linux cpuinfo flag names).
      flags=" $(grep -m1 '^flags' /proc/cpuinfo 2>/dev/null | cut -d: -f2) "
      vendor="$(grep -m1 '^vendor_id' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | tr -d ' ')"
      family="$(grep -m1 '^cpu family' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | tr -d ' ')"
      has() { for f in "$@"; do case "$flags" in *" $f "*) ;; *) return 1 ;; esac; done; return 0; }
      # pdep/pext are microcoded (slow) on AMD family 15h/17h (Excavator, Zen 1/2).
      slow_bmi2=0
      [ "$vendor" = AuthenticAMD ] && { [ "$family" = 21 ] || [ "$family" = 23 ]; } && slow_bmi2=1
      if ! has sse4_1 popcnt; then echo x86-64
      elif ! has avx2; then echo x86-64-sse41-popcnt
      elif ! has bmi2 || [ $slow_bmi2 = 1 ]; then echo x86-64-avx2
      elif ! has avx512f avx512vl avx512bw; then
        if has avx_vnni; then echo x86-64-avxvnni; else echo x86-64-bmi2; fi
      elif ! has avx512_vnni; then echo x86-64-avx512
      elif ! has avx512ifma avx512vbmi avx512_vbmi2 avx512_vpopcntdq avx512_bitalg vpclmulqdq gfni vaes; then
        echo x86-64-vnni512
      else echo x86-64-avx512icl; fi ;;
    aarch64)
      features=" $(grep -m1 '^Features' /proc/cpuinfo 2>/dev/null | cut -d: -f2) "
      case "$features" in *" asimddp "*) echo armv8-dotprod ;; *) echo armv8 ;; esac ;;
    *) echo unknown ;;
  esac
}
SF_BIN=/app/engines/stockfish/stockfish
expected="$(best_variant)"
selected=""
if [ -x "$SF_BIN" ]; then
  # `compiler` prints "Compilation architecture : <variant>" for the variant in use.
  selected="$( (echo compiler; sleep 1; echo quit) | timeout 10 "$SF_BIN" 2>/dev/null \
    | sed -n 's/^Compilation architecture *: *//p' | head -1 || true)"
fi
cpus="$(nproc 2>/dev/null || echo '?')"
# `cpus:` in compose is a CFS quota (cgroup v2 cpu.max "<quota> <period>"), invisible to nproc.
quota="$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || true)"
case "$quota" in
  max*|'') ;;
  *) cpus="$cpus (quota $(echo "$quota" | awk '{ printf "%.2g", $1 / $2 }'))" ;;
esac
log "cpu: $(uname -m), $cpus usable cpus, best Stockfish variant for this CPU: $expected, selected: ${selected:-unknown}"
if [ -z "$selected" ]; then
  log "warning: Stockfish at $SF_BIN did not answer 'compiler'; the engine may not start"
elif [ "$selected" != "$expected" ] && [ "$expected" != unknown ]; then
  log "warning: Stockfish selected $selected but /proc/cpuinfo suggests $expected"
fi

# ---- 3. Maia default ----------------------------------------------------------------------
if [ -z "${MAIA:-}" ]; then
  if [ "${DAISYCHESS_IMAGE_MAIA:-1}" != 1 ] || [ ! -x /app/engines/lc0/lc0 ]; then
    MAIA=off
    export MAIA
    log "maia: image built without Lc0/Maia; MAIA=off"
  fi
fi
# Never log credentials or query strings that may be part of a (mis)configured URL.
hub="$(printf '%s' "${HUB_URL:-<unset>}" | sed -e 's#//[^/@]*@#//***@#' -e 's#[?].*##')"
log "maia: ${MAIA:-on}; hub: $hub; pool: ${NODE_POOL:-off}"

exec "$@"
