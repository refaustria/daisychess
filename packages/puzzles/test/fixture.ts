import csv from './fixtures/puzzles-sample.csv?raw';
import { rowFromCsv, type CsvPuzzle } from '../src/csv.js';

/** Lines of the committed fixture (header first): 300 real rows of the lichess puzzle database (CC0). */
export const fixtureLines: string[] = csv.split('\n').filter((l) => l.length > 0);

/** Every fixture row, parsed and validated. */
export const fixturePuzzles: CsvPuzzle[] = fixtureLines.flatMap((l) => {
  const r = rowFromCsv(l);
  return r.ok ? [r.puzzle] : [];
});
