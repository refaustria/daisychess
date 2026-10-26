# Contributing to DaisyChess

Thanks for helping! DaisyChess is GPL-3.0-or-later; by contributing you agree that your contribution is licensed the same way.

## Setup

Requirements: Node >= 20 and pnpm (see `packageManager` in `package.json`).

```bash
pnpm install
pnpm dev:web          # http://localhost:5180, browser mode (WASM Stockfish) works without the server
pnpm fetch-engines    # optional: native Stockfish 19 + Maia nets into ./engines (checksum-verified)
pnpm build-lc0        # optional: Lc0 for the Maia engines (needs meson, ninja, g++, libeigen3-dev, zlib1g-dev)
pnpm dev:server       # http://127.0.0.1:8580, needs the engines above
```

## Checks

Before opening a PR run, from the repo root:

```bash
pnpm lint && pnpm test && pnpm build
```

`pnpm e2e` runs the Playwright tests (first run: `pnpm --filter @daisychess/web exec playwright install chromium`).

## Conventions

- TypeScript strict; no `any` without a comment explaining why.
- Frontend: React 18, Zustand, CSS modules + CSS variables. Server: Fastify, `ws`, Zod.
- Every public function in `packages/engine-core` has a unit test. New behaviour comes with tests.
- Do not change the WebSocket protocol or `engine-core` public interfaces without discussing it first (see `docs/DECISIONS.md`).
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(web): ...`, `fix(server): ...`.
- Never commit secrets or `.env*` files (only `*.env.example`). Security issues: see [`.github/SECURITY.md`](./.github/SECURITY.md).
