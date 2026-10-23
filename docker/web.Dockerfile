# syntax=docker/dockerfile:1
# Base images are pinned by digest (docs/SECURITY.md, supply chain); the tag is kept for
# readability. Refresh: docker pull <tag> && docker image inspect --format '{{index .RepoDigests 0}}' <tag>
# ChessLab web build served by nginx; proxies /ws and /health to the `server` service.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/engine-core/package.json packages/engine-core/
COPY packages/ui-theme/package.json packages/ui-theme/
RUN pnpm install --frozen-lockfile --filter @chesslab/web...
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @chesslab/engine-core build && pnpm --filter @chesslab/web build

FROM nginx:alpine@sha256:a3554c0d0b48177b1413c26e01f695334428020d9df01243fbae3e11cfd17417 AS runtime
COPY docker/nginx.web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
