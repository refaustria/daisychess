# Endgame tables (`/endgames/v1/`)

Syzygy endgame tablebases by Ronald de Man, as mirrored by lichess at
<https://tablebase.lichess.ovh/tables/standard/>. They are generated data published for free
redistribution. ADR-025 §2 (`docs/DECISIONS.md`) describes how DaisyChess uses them; the reader
is `packages/endgames/src/syzygy/` (a TypeScript port of python-chess's Syzygy probing code,
GPL-3.0-or-later).

`packages/endgames/tables.manifest.json` pins every file's name, kind, size, sha256 and pack.
`node packages/endgames/scripts/fetch-tables.mjs` downloads the files from the mirror and checks
them against the manifest, failing closed. The package test checks that this directory holds
exactly the core files of the manifest, byte for byte.

- **WDL** files (`.rtbw`) come from `3-4-5-wdl/`. Their digests match the mirror's published
  `sha256` list.
- **DTZ** files (`.rtbz`) come from `3-4-5-dtz-nr/`. These are the DTZ tables regenerated without
  rounding: they store plies instead of moves where the original `3-4-5-dtz/` files round. This
  is the data the lichess tablebase API answers with, so local and online DTZ agree exactly. The
  mirror publishes no checksums for `dtz-nr/`, so the digests in the manifest were taken from
  the download on 2026-11-06.

## Core pack (bundled here, shipped in `dist` and `dist-mobile`)

801,264 bytes in total. The limit is 1,000,000 (`TABLES_MAX_BYTES`, ADR-025 §2).

| Material | WDL | DTZ | Why                                                               |
| -------- | --- | --- | ----------------------------------------------------------------- |
| KQvK     | yes | yes | lesson K+Q vs K                                                   |
| KRvK     | yes | yes | lesson K+R vs K                                                   |
| KPvK     | yes | yes | lessons K+P vs K                                                  |
| KBBvK    | yes | yes | lesson K+2B vs K                                                  |
| KBNvK    | yes | yes | lesson K+B+N vs K                                                 |
| KQvKP    | yes | no  | lessons Q vs P (DTZ left out to stay under the budget, see below) |
| KQvKQ    | yes | no  | KQvKP after the pawn promotes                                     |
| KQvKR    | yes | no  | KQvKP after an underpromotion to a rook                           |
| KQvKB    | yes | no  | KQvKP after an underpromotion to a bishop                         |
| KQvKN    | yes | no  | KQvKP after an underpromotion to a knight                         |

Probing a position needs the WDL table of every material it can reach by captures and
promotions, because the reader resolves captures and probes every legal move
(`requiredTables(materialKey)` in the package). K+B vs K and K+N vs K are always drawn and need
no table.

With all six DTZ files the pack would weigh 1,055,296 bytes (KQvKP's unrounded DTZ is
254,032 bytes), over the budget. **KQvKP is therefore WDL-only offline.** Without its DTZ table
the trainer uses the `wdlTrappy` opponent policy for the Q vs P lessons (ADR-025 §6), and the
analysis shows no DTZ for these positions offline. The lichess API, when allowed, still answers
with DTZ.

## Rook pack (not in this directory; served from `/endgames/v1/` and downloaded on demand)

20,861,856 bytes, all WDL: KRPvKR (16,378,576), KRBvKR (2,035,280), KRNvKR (1,491,856),
KRRvKR (334,224), KQRvKR (279,824), KRvKP (179,408), KRvKN (100,048), KRvKB (32,912),
KRvKR (12,944), KRPvK (5,136), KQRvK (4,560), KRBvK (2,832), KRNvK (2,320) and KRRvK (1,936).
This is the capture and promotion closure of KRPvKR beyond the core pack. Underpromotions to a
bishop or a knight are why KRBvKR and KRNvKR (3.5 MB) are needed. `deploy/deploy-endgames.sh`
fetches it with `fetch-tables.mjs --pack rook`.
