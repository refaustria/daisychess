# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# DaisyChess community engine node (ROLE=node, ADR-020 §7, M24-8): the engine pool plus an
# outbound link to the hub. No inbound port; /health listens on the container's loopback only.
#
# Build from the repo root (multi-arch: linux/amd64, linux/arm64):
#   docker build -f docker/node.Dockerfile -t daisychess-node .
#   docker buildx build -f docker/node.Dockerfile --platform linux/amd64,linux/arm64 -t daisychess-node .
# Build args: WITH_MAIA=0 skips Lc0 + the Maia nets (smaller image, faster arm64 build);
#             STOCKFISH_ARM64=release uses the official arm64 release asset instead of the source build;
#             JOBS=<n> caps compile parallelism (default: all CPUs; use e.g. 4 on a shared host).
#
# Base images are pinned by digest (docs/SECURITY.md, supply chain); the tag is kept for
# readability; the BuildKit frontend (line 1) is pinned the same way. Both base digests are
# multi-arch indexes (amd64 + arm64). Refresh together with docker/server.Dockerfile:
#   docker buildx imagetools inspect <tag>   (top-level "Digest:")
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

# ---- app: compile TS and create a pruned production tree ---------------------------------
# Runs on the build machine's own platform: the output is plain JavaScript (no native addons in
# the server's production dependencies), so an arm64 image does not compile TypeScript under QEMU.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
# Matches "packageManager" in the root package.json (pnpm@12.11.2).
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/engine-core/package.json packages/engine-core/
COPY packages/ui-theme/package.json packages/ui-theme/
RUN pnpm install --frozen-lockfile --filter @daisychess/server...
# The context is an allow-list (docker/node.Dockerfile.dockerignore): sources and manifests only,
# never apps/server/.env.* or apps/server/data/.
COPY tsconfig.base.json ./
COPY packages/engine-core packages/engine-core
COPY apps/server apps/server
RUN pnpm --filter @daisychess/engine-core build && pnpm --filter @daisychess/server build
# Production dependencies only (engine-core is copied in, not symlinked); see server.Dockerfile.
RUN pnpm --filter @daisychess/server deploy --prod --legacy /out \
    && rm -rf /out/src /out/tsconfig*.json

# ---- stockfish: one universal binary per architecture (runtime instruction-set selection) ----
# amd64: the verified sf_19 release asset stockfish-linux-x86-64-universal (x86-64 … avx512icl in
#        one executable; Stockfish picks the best variant at start, sse41-popcnt on CPUs without
#        AVX2, ADR-003). sha256 checked against GitHub's digest and STOCKFISH_SHA256.
# arm64: built from the pinned, sha256-verified source tag with ARCH=arm64-universal
#        (armv8 + armv8-dotprod, runtime selection), scripts/build-stockfish.sh. sf_19 also
#        publishes stockfish-linux-arm64-universal; STOCKFISH_ARM64=release uses it instead.
FROM ${DEBIAN_IMAGE} AS stockfish
ARG TARGETARCH
ARG STOCKFISH_VERSION=sf_19
ARG STOCKFISH_SHA256=9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f
ARG STOCKFISH_ARM64=source
ARG STOCKFISH_ARM64_SHA256=fe26cfd1d9db4c8af3d21e24d9ff34cacb31c1f940085a7583da11796f2bac01
ARG STOCKFISH_SRC_SHA256=519b653d0d1ffb96531d982ccbe5c6a19425e8388e0e3c2f70f34b424ab32d76
ARG JOBS=
WORKDIR /repo
COPY scripts/fetch-engines.sh scripts/build-stockfish.sh scripts/
# $pkgs is a word list on purpose.
# hadolint ignore=SC2086
RUN set -eu; \
    case "$TARGETARCH/$STOCKFISH_ARM64" in \
      amd64/*|arm64/release) pkgs="curl ca-certificates tar jq" ;; \
      arm64/source) pkgs="curl ca-certificates tar make g++ binutils bsdextrautils" ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH STOCKFISH_ARM64=$STOCKFISH_ARM64" >&2; exit 1 ;; \
    esac; \
    apt-get update && apt-get install -y --no-install-recommends $pkgs && rm -rf /var/lib/apt/lists/*
# GITHUB_TOKEN (optional, API rate limit) comes in as a build secret, never as an ARG/layer:
#   docker build --secret id=github_token,env=GITHUB_TOKEN …
RUN --mount=type=secret,id=github_token,required=false set -eu; \
    if [ -s /run/secrets/github_token ]; then GITHUB_TOKEN="$(cat /run/secrets/github_token)"; export GITHUB_TOKEN; fi; \
    export STOCKFISH_VERSION MAIA=off; \
    case "$TARGETARCH/$STOCKFISH_ARM64" in \
      amd64/*) STOCKFISH_SHA256="$STOCKFISH_SHA256" bash scripts/fetch-engines.sh ;; \
      arm64/release) STOCKFISH_SHA256="$STOCKFISH_ARM64_SHA256" bash scripts/fetch-engines.sh ;; \
      arm64/source) STOCKFISH_SRC_SHA256="$STOCKFISH_SRC_SHA256" STOCKFISH_JOBS="$JOBS" bash scripts/build-stockfish.sh ;; \
    esac; \
    rm -rf engines/.tmp; ls -l engines/stockfish; cat engines/stockfish/VERSION

# ---- lc0 + maia (ADR-019): Eigen backend, portable baseline (amd64 SSE4.2, arm64 NEON) -----
FROM ${DEBIAN_IMAGE} AS lc0
ARG WITH_MAIA=1
ARG JOBS=
WORKDIR /repo
COPY scripts/build-lc0.sh scripts/fetch-maia.sh scripts/
RUN set -eu; mkdir -p engines/lc0 engines/maia; \
    if [ "$WITH_MAIA" = 1 ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates tar gzip meson ninja-build g++ python3 pkg-config zlib1g-dev libeigen3-dev \
      && rm -rf /var/lib/apt/lists/* \
      && bash scripts/fetch-maia.sh \
      && LC0_JOBS="$JOBS" bash scripts/build-lc0.sh \
      && rm -rf engines/.tmp; \
    else echo "WITH_MAIA=$WITH_MAIA: image without Lc0/Maia (MAIA=off at runtime)"; fi; \
    ls -l engines/lc0 engines/maia

# ---- runtime -------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG WITH_MAIA=1
LABEL org.opencontainers.image.title="daisychess-node" \
      org.opencontainers.image.description="DaisyChess community engine node (Stockfish + Lc0/Maia) linking to a DaisyChess hub" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"
# tini as PID 1: forwards SIGTERM to node (drain, then engine children are stopped) and reaps
# exited engine processes. Lc0 needs zlib (libz.so.1, part of the base) and libstdc++ (node's).
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin daisychess
WORKDIR /app/server
# Everything is owned by root and read-only for the service user (nothing in /app is written).
COPY --from=app /out /app/server
COPY --from=stockfish /repo/engines/stockfish /app/engines/stockfish
COPY --from=lc0 /repo/engines/lc0 /app/engines/lc0
COPY --from=lc0 /repo/engines/maia /app/engines/maia
COPY docker/engines.node.json /app/server/engines.json
COPY LICENSE THIRD_PARTY_NOTICES.md /app/
COPY --chmod=0755 docker/node-entrypoint.sh /app/node-entrypoint.sh
# ROLE=node never opens a public listener: config.ts forces /health onto loopback for this role,
# so HOST is 127.0.0.1 here (the health check runs inside the container). The node writes no
# files (no review store, no hub store), so the root filesystem can be mounted read-only.
# HUB_URL and NODE_TOKEN are not baked into the image ENV: they come from the environment
# (docker/node.env.example); the token is never baked in, and an unset HUB_URL defaults to the
# public hub wss://hub.daisychess.org/link in node-entrypoint.sh (ADR-021).
ENV NODE_ENV=production ROLE=node HOST=127.0.0.1 PORT=8580 \
    ENGINES_CONFIG=/app/server/engines.json REVIEW_STORE=off \
    DAISYCHESS_IMAGE_MAIA=${WITH_MAIA} HOME=/tmp
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||8580)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["tini","--","/app/node-entrypoint.sh"]
CMD ["node","dist/index.js"]
