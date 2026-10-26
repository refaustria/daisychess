// Types for build-puzzles.mjs (imported by build-puzzles.test.ts).
export const DEFAULT_SOURCE: string;

export interface BuildOptions {
  input: string;
  out?: string;
  starter?: string;
  sample?: number;
  sha256?: string;
  source?: string;
  lastModified?: string;
  builtAt?: string;
  /** Worker threads of the legality check (default {@link defaultJobs}). */
  jobs?: number;
  dryRun: boolean;
  zstdCli: boolean;
}

export interface BuildSummary {
  sha256: string;
  bytes: number;
  partial: boolean;
  rows: number;
  hardFiltered: number;
  legalityChecked: number;
  rejects: Record<string, number>;
  curated: number;
  shards: { file: string; band: number; count: number; bytes: number }[];
  shardBytes: number;
  indexBytes: number;
  starter: { rows: number; daily: number; bytes: number };
  perBand: Record<string, number>;
  perTheme: Record<string, number>;
  starterPerTheme: Record<string, number>;
  maxRssMb: number;
  seconds: number;
}

export function defaultJobs(): number;
export function illegalRows(
  rows: { fen: string; moves: string[] }[],
  jobs: number,
): Promise<Set<number>>;
export class UsageError extends Error {}
export function parseArgs(argv: string[]): BuildOptions;
export function hashFile(path: string, limit: number): Promise<string>;
export function streamLines(
  path: string,
  opts: { sample?: number; zstdCli?: boolean },
  onLine: (line: string) => void,
): Promise<{ bytes: number; partial: boolean }>;
export function buildPuzzles(o: BuildOptions, log?: (line: string) => void): Promise<BuildSummary>;
