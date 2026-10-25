# Third-party notices

DaisyChess itself is licensed under **GPL-3.0-or-later** (see `LICENSE`). It uses and distributes the components below. Versions are those pinned in `pnpm-lock.yaml` / the fetch scripts at the time of writing.

## Distributed with the web app (served to browsers)

| Component | Version | Licence | Source |
|---|---|---|---|
| Stockfish (WebAssembly build, npm package `stockfish`; the Stockfish developers, derived from Glaurung/Tord Romstad) | 19.0.1 | GPL-3.0 | https://github.com/official-stockfish/Stockfish , npm: https://www.npmjs.com/package/stockfish |
| chessground (lichess board UI; includes the Cburnett piece set CSS/SVG) | 9.2.1 | GPL-3.0-or-later | https://github.com/lichess-org/chessground |
| Cburnett chess pieces (Colin M.L. Burnett, shipped via chessground) | - | GPL-2.0-or-later (also BSD / GFDL tri-licensed upstream) | https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces |
| chess.js | 1.4.0 | BSD-2-Clause | https://github.com/jhlywa/chess.js |
| React, React DOM | 18.3.1 | MIT | https://github.com/facebook/react |
| Zustand | 5.0.16 | MIT | https://github.com/pmndrs/zustand |
| Zod | 4.6.7 | MIT | https://github.com/colinhacks/zod |
| lichess `chess-openings` (ECO/opening names, commit a6189a30, vendored as `apps/web/src/openings/data/openings.json`) | - | CC0-1.0 | https://github.com/lichess-org/chess-openings |

## Distributed or used on the engine server (not shipped to browsers)

| Component | Version | Licence | Source |
|---|---|---|---|
| Stockfish (native binary, fetched by `pnpm fetch-engines`, sha256-verified) | 19 | GPL-3.0 | https://github.com/official-stockfish/Stockfish |
| Leela Chess Zero (Lc0, built by `pnpm build-lc0`) | v0.32.1 | GPL-3.0-or-later (with an additional permission for linking NVIDIA CUDA/cuDNN, not used here) | https://github.com/LeelaChessZero/lc0 |
| Maia networks 1100-1900 (CSSLab, University of Toronto; McIlroy-Young et al., KDD 2020; fetched by `pnpm fetch-engines`, sha256-pinned) | commit pinned in `scripts/fetch-maia.sh` | GPL-3.0 | https://github.com/CSSLab/maia-chess |
| Fastify | 5.x | MIT | https://github.com/fastify/fastify |
| ws | 8.22.0 | MIT | https://github.com/websockets/ws |
| Zod, chess.js | see above | MIT / BSD-2-Clause | see above |

Engine binaries and nets are downloaded or built on the operator's machine and are git-ignored; they are not stored in this repository.

## Assets in this repository

| Asset | Licence / provenance |
|---|---|
| DaisyChess logo, favicons, icons (`apps/web/public/brand/`, `apps/web/public/favicon.svg`) | Original work of this project, GPL-3.0-or-later |
| "Letters" piece set (`packages/ui-theme/src/pieces/letters.css`) | Original work of this project (MIT per `pieceSets.ts`; distributed here under GPL-3.0-or-later) |
| Board themes (`packages/ui-theme/src/boardThemes.ts`) | Colour values only. Brown, blue, green and purple use the well-known lichess board colours (plain hex values, not copyrightable artwork); wood and grey are plain hex values modelled on chess.com board colours (colour values only, no artwork; owner confirmed 2026-10-25) |
| Sounds (`apps/web/src/sound/sounds.ts`) | Synthesised at runtime with the Web Audio API; no audio files |
| Fonts | None bundled; system font stacks only |

## Development-only dependencies (not distributed)

Build and test tooling (Vite, Vitest, Playwright, ESLint, TypeScript, Testing Library, ...) is licensed MIT, Apache-2.0, ISC or BSD. Notable exceptions, none shipped to users: `axe-core` and `@axe-core/playwright` (MPL-2.0), `caniuse-lite` (CC-BY-4.0, data), `argparse` (Python-2.0).

## Compatibility check

Every runtime dependency is MIT, BSD-2-Clause, GPL-3.0 or GPL-3.0-or-later and therefore compatible with distributing the combined work under GPL-3.0-or-later. Because chessground is GPL-3.0-or-later and Stockfish is GPL-3.0 (source headers: "version 3 or, at your option, any later version"), choosing "-or-later" for this project is compatible. No runtime dependency with an incompatible licence (for example GPL-2.0-only, proprietary, or a licence with an advertising clause) was found. Fairy-Stockfish (GPL-3.0) is supported by the engine registry but not bundled.
