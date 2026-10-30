// Types for calibrate-elo.mjs (imported by calibrate-elo.test.ts).
import type { EloCalibration, SpeedClass } from '@daisychess/engine-core';

export const DEFAULT_OPENINGS: string;
export const DEFAULT_MIN_SAMPLES: number;
export const DEFAULT_MAX_KNOTS: number;
export const START_EVAL: Readonly<{ cp: number }>;
export const SPEED_ORDER: readonly ['bullet', 'blitz', 'rapid', 'classical'];

export interface CalibrateOptions {
  input: string;
  out?: string;
  month?: string;
  limit?: number;
  sample?: number;
  sha256?: string;
  dumpSha256?: string;
  source?: string;
  minSamples?: number;
  maxKnots?: number;
  openings?: string;
  jobs?: number;
  builtAt?: string;
  dryRun: boolean;
  zstdCli: boolean;
}

export type WhiteScore = { cp: number } | { mate: number };

export interface EligibleGame {
  white: number;
  black: number;
  timeControl?: string;
  movetext: string;
}

export interface EloSamplePoint {
  speed: SpeedClass;
  rating: number;
  meanLoss: number;
  positions: number;
}

export interface BatchResult {
  /** Flat `[speedIndex, rating, meanLoss, positions, …]`. */
  samples: number[];
  rejects: Record<string, number>;
  games: number;
  used: number;
}

export interface BookIndex {
  inBook(prefix: readonly string[]): boolean;
  lineAt(epd: string): readonly string[] | undefined;
}

export interface CalibrateSummary {
  sha256: string;
  bytes: number;
  partial: boolean;
  month: string;
  gamesRead: number;
  analyzed: number;
  used: number;
  rejects: Record<string, number>;
  samples: Record<string, number>;
  table: EloCalibration;
  seconds: number;
  maxRssMb: number;
}

export function defaultJobs(): number;
export class UsageError extends Error {}
export function parseArgs(argv: string[]): CalibrateOptions;
export function monthFromName(path: string): string | undefined;
export function hashFile(path: string, limit: number): Promise<string>;
export function readLines(
  path: string,
  opts: { sample?: number; zstdCli?: boolean },
  info: { bytes: number; partial: boolean },
): AsyncGenerator<string>;
export function createGameSplitter(): {
  push(line: string): { tags: Record<string, string>; movetext: string } | undefined;
  flush(): { tags: Record<string, string>; movetext: string } | undefined;
};
export function parseEval(body: string): WhiteScore | undefined;
export function parseMovetext(text: string): { sans: string[]; evals: (WhiteScore | undefined)[] };
export function eligibleGame(g: {
  tags: Record<string, string>;
  movetext: string;
}): { ok: false; reason: string } | { ok: true; game: EligibleGame };
export function buildBookIndex(rows: readonly (readonly string[])[]): BookIndex;
export function toEpd(fen: string): string;
export function bookWalker(book: BookIndex): {
  step(san: string, epd: () => string): void;
  readonly lastBookPly: number;
};
export function lastBookPlyOf(
  book: BookIndex,
  sans: readonly string[],
  epds: readonly string[],
): number;
export function loadEngineCore(): Promise<typeof import('@daisychess/engine-core')>;
export function analyzeGame(
  E: typeof import('@daisychess/engine-core'),
  book: BookIndex,
  game: EligibleGame,
): { samples: EloSamplePoint[]; reason?: string };
export function analyzeBatch(
  E: typeof import('@daisychess/engine-core'),
  book: BookIndex,
  games: EligibleGame[],
): BatchResult;
export function isotonicDecreasing(
  points: readonly (readonly [number, number])[],
): { x: number; y: number; w: number }[];
export function decimate(
  blocks: readonly { x: number; y: number; w: number }[],
  maxKnots: number,
): { x: number; y: number; w: number }[];
export function interpolate(knots: readonly (readonly [number, number])[], x: number): number;
export function fitCurve(
  points: readonly (readonly [number, number])[],
  maxKnots?: number,
): { knots: [number, number][]; residualSd: number } | undefined;
export function formatTable(table: unknown): string;
export function calibrateElo(
  o: CalibrateOptions,
  log?: (line: string) => void,
): Promise<CalibrateSummary>;
