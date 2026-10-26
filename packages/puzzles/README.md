# @daisychess/puzzles

Pure TypeScript core of the Puzzles feature (ADR-023 in `docs/DECISIONS.md`): data formats,
CSV parsing and curation for the build pipeline, the solver state machine, Glicko-2, puzzle
selection, daily/rush sequences, theme labels, the opening-tag mapping and the stage-2 rules
for puzzles from the user's own mistakes.

- No DOM and no Node APIs; runtime dependencies are `chess.js` and `zod` only. `engine-core` is
  deliberately not used (its SHA-256 is copied to `src/sha256.ts`).
- Built to `dist/` (`pnpm --filter @daisychess/puzzles build`, `sideEffects: false`) for the Node
  pipeline (`scripts/build-puzzles.mjs`, M30-2); the web imports the source through a workspace
  alias, like engine-core.
- Tests: `pnpm --filter @daisychess/puzzles test`. `test/fixtures/puzzles-sample.csv` holds 300
  real rows of the lichess puzzle database (CC0-1.0, <https://database.lichess.org/#puzzles>,
  2026-10 dump): 191 pass the hard filter, 115 carry opening tags, rare themes included.

## Data formats (`format: 1`, URL path `/puzzles/v1/`)

| Export                                  | Shape                                                                                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Puzzle`                                | `{ id, fen, moves: string[] (UCI, moves[0] = opponent's intro), rating?, rd?, themes, openings, game?, source: 'lichess' \| 'mistake', noIntro? }`                                                         |
| `PuzzleRowSchema` / `PuzzleRow`         | `[id, fen, 'uci uci …', rating, rd, themeIdx[], openingIdx[], game]` (`game` = `''` when unknown)                                                                                                          |
| `ShardSchema` / `Shard`                 | `{ format, dataset (sha256 of the dump), band, rows }`                                                                                                                                                     |
| `PuzzleIndexSchema` / `PuzzleIndex`     | `{ format, dataset: { source, sha256, lastModified, builtAt, total }, themes, openings, families, bandSize: 100, shards: { file, band, count, bytes, themes, families }[], counts: { themes, openings } }` |
| `StarterSchema` / `Starter`             | `{ format, dataset, themes, openings, rows, daily: number[] }`                                                                                                                                             |
| `DatasetInfoSchema`, `ShardEntrySchema` | parts of the index                                                                                                                                                                                         |
| constants                               | `PUZZLE_FORMAT = 1`, `BAND_SIZE = 100`, `MIN_BAND = 500`, `MAX_BAND = 2900` (open-ended)                                                                                                                   |

Count maps (`themes`/`families` of a shard entry) are `Record<number, number>`; JSON keys are
strings and the schema accepts only non-negative integer keys. A shard file name must match
`shards/<band>-<16 hex>.json`.

## Pipeline (Node, M30-2)

| Function                                                                                                       | Purpose                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseCsvLine(line)`                                                                                           | fields of one CSV line (RFC 4180 quotes tolerated, trailing `\r` dropped)                                                                                                        |
| `rowFromCsv(lineOrFields, { checkLegality? = true })`                                                          | `{ ok: true, puzzle: CsvPuzzle }` or `{ ok: false, reason }` (`header`, `columns`, `id`, `number`, `fen` (> 100 chars), `moves` (not 2…20 UCI), `themes`, `openings`, `illegal`) |
| `lineIsLegal(fen, moves)`                                                                                      | chess.js legality of a UCI line (run after the cheap filter)                                                                                                                     |
| `hardFilter(p)`                                                                                                | popularity ≥ 90, RD ≤ 80, ≥ 300 plays, rating ≥ 500 (`HARD_FILTER`)                                                                                                              |
| `selectCurated(puzzles, { quotaPerBand: 16000, themeFloor: 600, minBand?, maxBand? })`                         | most played per band, then every theme topped up to the floor; sorted by id                                                                                                      |
| `pickStarter(curated, { size: 6000, quotaPerBand: 300, themeFloor: 20, minBand: 600, maxBand: 2500 })`         | starter rows; trimmed to `size` from the least played rows of the fullest bands, never below a theme floor                                                                       |
| `pickDailyPool(starter, { size: 1000, seed, minRating: 1300, maxRating: 2000, minPopularity: 95, maxRd: 75 })` | indexes into `starter`, seeded shuffle (`seededRandom`, mulberry32)                                                                                                              |
| `buildDictionary(puzzles)`                                                                                     | sorted `themes`/`openings` + `families` (indexes of first tags)                                                                                                                  |
| `encodeRow(p, dict)` / `rowEncoder(dict)`                                                                      | `CsvPuzzle` → `PuzzleRow`                                                                                                                                                        |
| `shardByBand(puzzles, dict, { maxRows: 2000 })`                                                                | `{ band, rows }[]`, a band split into equal parts, rows sorted by id                                                                                                             |
| `buildIndex({ dataset, dictionary, shards: { band, rows, file, bytes }[] })`                                   | `PuzzleIndex` with per-shard theme/family counts and global counts; `dataset.total` computed                                                                                     |
| `buildStarter({ dataset, puzzles, daily })`                                                                    | `Starter` with its own dictionary                                                                                                                                                |
| `STARTER_MAX_BYTES`                                                                                            | 1,000,000 (the pipeline and `check-dist` assert it)                                                                                                                              |

The pipeline serialises each draft, names it `shards/<band>-<16 hex of sha256(content)>.json`
and then builds the index from the written shards.

## Client (web)

| Function                                                                         | Purpose                                                                                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `decodeRow(row, indexOrStarter)`                                                 | `PuzzleRow` → `Puzzle` (`source: 'lichess'`); throws `RangeError` on an out-of-range index — treat the shard as missing |
| `bandOf(rating)`                                                                 | 100-point band, clamped to 500…2900                                                                                     |
| `difficultyWindow(rating, 'easier' \| 'normal' \| 'harder', widen = 0)`          | `{ min, max }`: normal `[r−100, r+200]`, easier `[r−300, r−50]`, harder `[r+150, r+450]`, ±200 per widen step           |
| `chooseShards(index, { window, filter?, exclude?, max = 3, random? })`           | overlapping shards with possible matches, weighted sample without replacement                                           |
| `shardWeight(index, shard, filter)`                                              | the weight used above (count / theme count / family count, the smallest)                                                |
| `choosePuzzle(puzzles, { window, filter?, seen?, random? })`                     | random unseen match in the window, or `undefined`                                                                       |
| `matchesFilter(puzzle, { theme?, opening? })`                                    | opening = family or variation tag                                                                                       |
| `dailyIndex(dateUtc, poolSize)`                                                  | `daysSince(2026-01-01 UTC) mod poolSize`; use as `starter.daily[dailyIndex(…)]`                                         |
| `utcDateKey(date)`                                                               | `YYYY-MM-DD` (UTC)                                                                                                      |
| `rushPlan(pool, seen, { count: 60, start: 800, step: 25, spread: 5, random })`   | rising targets, nearest unused puzzle, never a `seen` one, unrated ignored                                              |
| `glicko2Update(player, results, tau = 0.75)`                                     | Glickman's algorithm; `GLICKO_DEFAULT` = 1500 / 350 / 0.09; RD capped at 350                                            |
| `formatPuzzleRating({ rating, rd })`                                             | `"1620 ± 85"`                                                                                                           |
| `THEMES`, `THEME_GROUPS`, `themeInfo`, `themeLabel`, `themesByGroup(available?)` | our labels/descriptions for all 73 lichess themes, groups Mates / Tactics / Phase / Length / Special                    |
| `openingTag(name)`                                                               | `Queen's Pawn Game: Accelerated London System` → `Queens_Pawn_Game_Accelerated_London_System`                           |
| `openingFamily(tag, families)`                                                   | longest family that equals the tag or is its `_` prefix                                                                 |
| `openingTagsForName(name)`                                                       | `{ family, variation? }`: lichess tags only the first variation level, so the variation is cut at the first `,`         |

### Solver

`checkMove(fen, expectedUci, playedUci)` → `'correct' | 'mate' | 'wrong' | 'illegal'`:
the expected move is correct; any other mating move is accepted (`mate`, solves at once at any
step); promotions compare the full UCI; a king move onto its own rook (`e1h1`) is read as castling
(`normalizeUci`). Illegal input is not a miss.

`solutionState(stateOrPuzzle, event)` is the pure reducer (`initialSolution(puzzle)` gives the
first state; passing a puzzle means its initial state). Events: `start`, `advance` (the app plays
`pendingMove(state)` — intro, opponent reply or a move of the shown solution), `move { uci }`,
`retry`, `hint`, `showSolution`. Phases: `intro → user ⇄ opponent → complete`, plus `wrong` and
`showing`. `result` is settled at the first terminal event — first wrong move, hint or "Show
solution" → `failed`; the end without any → `solved` — and is kept across `start` (retries are
free). `userSide(puzzle)` is the side to move after the intro (or in `fen` with `noIntro`).

## Stage 2: puzzles from own mistakes

- `mistakeCandidates(review, userSide)`: plies of `userSide` classified `mistake`/`blunder` with a
  `bestUci`, excluding positions where the best move leaves the user below 20 % (`evalIfBest`,
  else `evalBeforeWhite`), deduplicated by `mistakeId(fen)` = `m:<16 hex of sha256(fen)>`. The
  intro is the opponent's previous move when it leads to the position; at ply 1 (or without a
  usable previous detail) there is no intro and the puzzle gets `noIntro: true`.
- `cutSolution(candidate, results)`: deterministic over the supplied searches (matched by
  position); returns `{ type: 'search', fen, multipv, purpose: 'start' | 'reply' | 'final' }`
  until it has what it needs, then `{ type: 'accept', puzzle, solution, userMoves }` or
  `{ type: 'skip', reason }`. `SearchResult.lines[].score` is from the point of view of the side
  to move in `fen` (raw UCI). Rules (`CUT_LIMITS`): start best vs second ≥ 10 win-probability
  points and, for two cp evals, ≥ 80 cp; a reply is forced unless the second best is within 100 cp
  or 5 points; ≤ 3 user moves; the end may be at most 50 cp worse for the user than the start
  (same sign for mates; a better end is fine), else the shortest cut that holds, else skip;
  ≤ 4 searches (`start`, up to two `reply`, `final` only when the end position has no eval yet).
  Search budgets (1,000 ms / 500 ms / depth 16) are the caller's choice by `purpose`.
- `winProbability(score)`, `scoreFor(scoreWhite, side)`: lichess sigmoid helpers.
