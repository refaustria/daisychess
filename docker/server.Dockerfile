# syntax=docker/dockerfile:1
# Base images are pinned by digest (docs/SECURITY.md, supply chain); the tag is kept for
# readability. Refresh: docker pull <tag> && docker image inspect --format '{{index .RepoDigests 0}}' <tag>
# ChessLab engine server. Build from the repo root:
#   docker build -f docker/server.Dockerfile -t chesslab-server .

# ---- build: compile TS and create a pruned production tree -------------------------
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
# Matches "packageManager" in the root package.json (pnpm@12.11.2).
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

# Manifests first so the install layer is cached until dependencies change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/engine-core/package.json packages/engine-core/
COPY packages/ui-theme/package.json packages/ui-theme/
RUN pnpm install --frozen-lockfile --filter @chesslab/server...

COPY tsconfig.base.json ./
COPY packages/engine-core packages/engine-core
COPY apps/server apps/server
RUN pnpm --filter @chesslab/engine-core build && pnpm --filter @chesslab/server build
# pnpm >= 10 refuses `deploy` unless inject-workspace-packages is set (workspace deps
# are then copied, not symlinked, which is what we want in an image). --legacy keeps
# the old behaviour without touching workspace config.
RUN pnpm --filter @chesslab/server deploy --prod --legacy /out

# ---- engine: Stockfish release binary -----------------------------------------------
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8 AS engine
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar jq \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY scripts/fetch-engines.sh scripts/
# Supply chain (docs/SECURITY.md): the release is pinned and the asset's sha256 is checked
# against both the digest GitHub publishes and STOCKFISH_SHA256 below (the sf_19
# stockfish-linux-x86-64-universal.tar.gz digest). Bump both together when upgrading; set
# STOCKFISH_SHA256= (empty) to rely on GitHub's digest alone. sf_19+ universal builds choose
# the instruction set at runtime, so no arch is needed by default.
ARG STOCKFISH_VERSION=sf_19
ARG STOCKFISH_SHA256=9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f
ARG STOCKFISH_ARCH=
ARG GITHUB_TOKEN=
ENV STOCKFISH_VERSION=${STOCKFISH_VERSION} STOCKFISH_SHA256=${STOCKFISH_SHA256} \
    STOCKFISH_ARCH=${STOCKFISH_ARCH} GITHUB_TOKEN=${GITHUB_TOKEN}
RUN bash scripts/fetch-engines.sh

# ---- runtime ------------------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS runtime
# tini as PID 1: forwards SIGTERM to node (clean shutdown, engine children get killed)
# and reaps zombie Stockfish processes. Compose also works with `init: true`.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin chesslab
WORKDIR /app/server
COPY --from=build --chown=chesslab:chesslab /out /app/server
COPY --from=engine --chown=chesslab:chesslab /repo/engines/stockfish /app/engines/stockfish
COPY --chown=chesslab:chesslab docker/engines.docker.json /app/server/engines.json
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8580 ENGINES_CONFIG=/app/server/engines.json
USER chesslab
EXPOSE 8580
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node","-e","fetch('http://127.0.0.1:8580/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["tini","--"]
CMD ["node","dist/index.js"]
