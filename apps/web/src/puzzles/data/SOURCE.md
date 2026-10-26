# Puzzle starter set source

`starter.json` is the bundled starter set of the Puzzles tab (ADR-023 §3–§4): puzzles from the
lichess.org puzzle database, <https://database.lichess.org/#puzzles>, licence **CC0-1.0**.

**Initial development starter (M30-3), to be replaced by the full pipeline run (M30-8).**

- Input: a 12,000,001-byte ranged prefix of `lichess_db_puzzle.csv.zst` (2026-10 dump, the file
  is ordered by puzzle id, so the prefix is representative), decompressed to 238,567 lines
  (the cut-off last line dropped). Not the full dump.
- `dataset`: sha256 of that 12 MB prefix,
  `fd8fe5f64eab9e2dc5fcde4a950d7b979635777983cbdbadeb20d356436c9ef1` (the full run records the
  sha256 of the whole dump instead).
- Built: 2026-10-26 with `@daisychess/puzzles` (`rowFromCsv` → `hardFilter` → `lineIsLegal` →
  `pickStarter()` with `STARTER_DEFAULTS` → `pickDailyPool()` with `DAILY_DEFAULTS` →
  `buildStarter`).
- Counts: 73,354 rows passed the hard filter (all legal); starter 6,000 rows (bands 600–2500,
  ≈ 300 per band; 250 at 600, 175 at 2500), 73 themes, 503 opening tags, daily pool 858 rows
  (fewer than 1,000 because the sample is small); 858,237 bytes (limit 1,000,000).

Regenerate with the pipeline (M30-2):
`node packages/puzzles/scripts/build-puzzles.mjs --input <lichess_db_puzzle.csv.zst> --out <dir> --starter apps/web/src/puzzles/data/starter.json`
(normally through `deploy/deploy-puzzles.sh`, which also records the dump digest here).
