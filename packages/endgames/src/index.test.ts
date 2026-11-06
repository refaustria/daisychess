import { describe, expect, it } from 'vitest';
import * as api from './index.js';

describe('package entry', () => {
  it('exports the public API of ADR-025 (M32-1)', () => {
    for (const name of [
      'ENDGAME_FAMILIES',
      'LESSON_GROUPS',
      'sideMaterial',
      'materialSignature',
      'normalizeMaterialKey',
      'materialKey',
      'endgameFamily',
      'puzzleThemeFor',
      'lessonGroupFor',
      'lessonFamilyFor',
      'ENDGAME_MAX_PIECES',
      'ENDGAME_MIN_PLIES',
      'nonPawnPieces',
      'endgameStart',
      'TB_CATEGORIES',
      'LICHESS_CATEGORIES',
      'LichessTablebaseSchema',
      'LichessTablebaseMoveSchema',
      'normalizeLichess',
      'TABLEBASE_MAX_PIECES',
      'moverResult',
      'rankMoves',
      'keepers',
      'bestMove',
      'judgeMove',
      'tbScoreHint',
      'pieceCount',
      'tablebaseEligible',
      'fenAfter',
      'opponentMove',
      'MaterialKeySchema',
      'LessonSchema',
      'initialLesson',
      'lessonState',
      'budgetLeft',
      'shownHints',
      'TABLES_MAX_BYTES',
      'TableEntrySchema',
      'TablesManifestSchema',
      'tableFileName',
      'tablesFor',
      'packBytes',
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });
});
