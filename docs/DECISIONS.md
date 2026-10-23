# Architecture Decision Records

## ADR-001 — Ports on the production host
**Date:** 2026-10-23 · **Status:** accepted

**Context.** The README suggests the engine server on 8080 and the Vite dev server on 5173. On the production host (c.referee.at) 8080 is used by an unrelated service and 5173 by another dev server.

**Decision.** The ChessLab server listens on `127.0.0.1:8580` by default (`PORT` env var). The Vite dev server uses `5180`. nginx terminates TLS and proxies `/ws` and `/health` to 8580.

**Consequences.** README dev section documents the new ports. Nothing is exposed directly; only nginx listens publicly.

## ADR-002 — Hosting model for c.referee.at
**Date:** 2026-10-23 · **Status:** accepted

**Context.** We need early, visible results and later server-mode analysis on the same machine. The host already runs nginx with certbot-managed vhosts.

**Decision.** Static frontend build is served by nginx from `/var/www/c.referee.at` with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (needed for multi-threaded WASM). TLS via Let's Encrypt (certbot nginx plugin). The engine server runs as a systemd service bound to localhost; nginx proxies `/ws`. Deployment config lives in `deploy/` in the repo. Docker compose (M6) remains for other hosts.

**Consequences.** All third-party resources must be same-origin or CORP-enabled (COEP). Deploy is a script, not CI (CI only tests).

## ADR-003 — Native Stockfish build target on this host
**Date:** 2026-10-23 · **Status:** accepted

**Context.** The VM CPU (QEMU virtual CPU) exposes SSE4.1/SSE4.2/POPCNT but **no AVX2/BMI2**.

**Decision.** `scripts/fetch-engines.sh` must detect CPU flags and select the `x86-64-sse41-popcnt` Stockfish build when AVX2 is absent (AVX2/BMI2 builds otherwise). 16 cores / 30 GB RAM are available; engine pool limits will be sized accordingly in M3.

**Consequences.** Lower NPS than an AVX2 build; still far stronger than browser WASM.

## ADR-004 — Node version
**Date:** 2026-10-23 · **Status:** accepted

**Context.** README says Node 20; host has Node 24.

**Decision.** Target `node >= 20` (`engines` field), CI matrix on Node 20 and 22. Host runs 24.

**Update 2026-10-23.** Stockfish 19 only ships "universal" Linux tarballs that select the instruction set at runtime; on this host the binary reports `x86-64-sse41-popcnt`. `scripts/fetch-engines.sh` prefers per-CPU assets when a release lists them (sf_18 and older) and falls back to the universal asset. Measured ~420 kNPS single-threaded at depth 12.
