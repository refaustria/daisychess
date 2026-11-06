# @daisychess/endgames

Pure TypeScript core of the Endgames feature (ADR-025 in `docs/DECISIONS.md`): material
signatures and endgame families, the endgame-start rule, tablebase types with the lichess API
schema, move judgments and ranking, the trainer's opponent policies, the lesson schema and state
machine, and the table manifest schema. The Syzygy reader (`src/syzygy/`) follows in M32-2.

- No DOM and no Node APIs; runtime dependencies are `chess.js` and `zod` only; no
  `engine-core` dependency.
- Built to `dist/` (`pnpm --filter @daisychess/endgames build`, `sideEffects: false`); the web
  imports the source through a workspace alias, like `@daisychess/puzzles`.
- Tests: `pnpm --filter @daisychess/endgames test`. `test/fixtures/lichess-krpvkr-win.json` is
  the real answer of `https://tablebase.lichess.ovh/standard?fen=1K6/1P1k4/8/8/8/8/r7/2R5_w_-_-_0_1`
  (fetched 2026-11-06).

## Modules

| Module       | Exports                                                                                                                                                                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `material`   | `materialSignature(fen) → {white, black, text}` (`R+3P vs R+2P`, `K` for a bare king), `materialKey(fen)` (`KRPvKR`, Syzygy naming), `normalizeMaterialKey`, `sideMaterial`, `endgameFamily(fen) → {family, pawnless, pawnsUp}`, `ENDGAME_FAMILIES`, `puzzleThemeFor`, `lessonGroupFor` (alias `lessonFamilyFor`) |
| `phase`      | `endgameStart(fens) → ply \| undefined` (`fens[i]` = position after ply `i + 1`; ≤ 6 non-pawn pieces and never more again, ≥ 4 endgame plies), `nonPawnPieces`                                                                                                                                                    |
| `tablebase/` | `TbCategory`, `TbPosition`, `TbMove`, `TbVerdict`, `TbScoreHint`, `TablebaseProbe`, `LichessTablebaseSchema`, `normalizeLichess(json, fen)`, `moverResult`, `judgeMove`, `rankMoves`, `keepers`, `bestMove`, `tbScoreHint`, `pieceCount`, `tablebaseEligible`                                                     |
| `opponent`   | `opponentMove(pos, probe, 'dtz' \| 'wdlTrappy') → Promise<uci>`, `fenAfter`                                                                                                                                                                                                                                       |
| `lessons/`   | `LessonSchema`, `MaterialKeySchema`, `initialLesson`, `lessonState(stateOrLesson, event)`, `budgetLeft`, `shownHints`                                                                                                                                                                                             |
| `manifest`   | `TablesManifestSchema`, `TableEntrySchema`, `TABLES_MAX_BYTES` (1,000,000), `tablesFor(materialKey, manifest)`, `tableFileName`, `packBytes`                                                                                                                                                                      |

## Conventions

- **Categories.** `TbPosition.category` is the side to move's result; `TbMove.category` is the
  result of the side to move **after** the move (lichess's convention). `normalizeLichess`
  returns `null` when the position or any move is `unknown`/`maybe-*`, and folds
  `syzygy-win`/`syzygy-loss` into `win`/`loss`. `dtz` prefers `precise_dtz`; `dtm`/`dtz` are in
  plies, signed from the side to move (`tbScoreHint.mateIn` converts to moves).
- **50-move rule.** `moverResult` folds `cursed-win`/`blessed-loss` into `draw`; judgments and
  keepers use the folded result; `tbScoreHint.exact50` is `false` for those two.
- **Ranking.** `rankMoves` sorts by the mover's exact result (win, cursed win, draw, blessed
  loss, loss), wins fastest first (checkmate, DTM, DTZ), losses slowest first, draws zeroing
  first, then UCI order.
- **Lesson reducer.** Pure: the tablebase data comes with the events (`move.tb` = the position
  before the user's move, `reply.tb` = optionally the position after the opponent's reply,
  `hint.tb`/`showMove.tb` = the current position); the store probes, the reducer never does.
  Hints and shown moves are counted in `hints`, take-backs in `mistakes`, restarts in
  `attempts`.
