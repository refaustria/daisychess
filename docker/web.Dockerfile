# syntax=docker/dockerfile:1
# ChessLab web build served by nginx; proxies /ws and /health to the `server` service.
FROM node:22-bookworm-slim AS build
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

FROM nginx:alpine AS runtime
COPY docker/nginx.web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
