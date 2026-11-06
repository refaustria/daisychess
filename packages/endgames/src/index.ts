export {
  ENDGAME_FAMILIES,
  LESSON_GROUPS,
  sideMaterial,
  materialSignature,
  normalizeMaterialKey,
  materialKey,
  endgameFamily,
  puzzleThemeFor,
  lessonGroupFor,
  lessonFamilyFor,
} from './material.js';
export type {
  Side,
  SideMaterial,
  MaterialSignature,
  EndgameFamily,
  EndgameClass,
  EndgameTheme,
  LessonGroup,
} from './material.js';
export { ENDGAME_MAX_PIECES, ENDGAME_MIN_PLIES, nonPawnPieces, endgameStart } from './phase.js';
export {
  TB_CATEGORIES,
  LICHESS_CATEGORIES,
  LichessTablebaseSchema,
  LichessTablebaseMoveSchema,
  normalizeLichess,
  TABLEBASE_MAX_PIECES,
  moverResult,
  rankMoves,
  keepers,
  bestMove,
  judgeMove,
  tbScoreHint,
  pieceCount,
  tablebaseEligible,
} from './tablebase/index.js';
export type {
  TbCategory,
  MoverResult,
  TbMove,
  TbPosition,
  TbVerdict,
  TbScoreHint,
  TablebaseProbe,
  LichessCategory,
  LichessTablebase,
} from './tablebase/index.js';
export { fenAfter, opponentMove } from './opponent.js';
export type { OpponentPolicy } from './opponent.js';
export {
  MaterialKeySchema,
  LessonSchema,
  initialLesson,
  lessonState,
  budgetLeft,
  shownHints,
} from './lessons/index.js';
export type {
  Lesson,
  LessonPhase,
  LessonFailure,
  LessonSuccess,
  LessonState,
  LessonEvent,
} from './lessons/index.js';
export {
  TABLES_MAX_BYTES,
  TableEntrySchema,
  TablesManifestSchema,
  tableFileName,
  tablesFor,
  packBytes,
} from './manifest.js';
export type { TableEntry, TablesManifest, TablePack } from './manifest.js';
export * from './syzygy/index.js';
