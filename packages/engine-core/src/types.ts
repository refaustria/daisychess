/** Evaluation from White's perspective: centipawns or moves-to-mate (negative = Black mates). */
export type Score = { cp: number } | { mate: number };

/**
 * One entry of a policy-network move distribution (ADR-019): the probability `p` (0…1) that
 * the engine's policy head assigns to `uci`. For a Maia net this is how often players of that
 * rating play the move.
 */
export interface PolicyEntry {
  uci: string;
  p: number;
}

export interface EngineInfo {
  depth: number;
  seldepth?: number;
  multipv: number;
  score: Score;
  /** Principal variation in UCI notation. */
  pv: string[];
  nps?: number;
  nodes?: number;
  /** Milliseconds. */
  time?: number;
  /**
   * Top policy moves (most probable first) of a policy-network engine such as Lc0 (ADR-019).
   * Sent once per search, on the last `info` before `bestmove`; absent for other engines.
   */
  policy?: PolicyEntry[];
}

export interface BestMove {
  move: string;
  ponder?: string;
}

export interface AnalyzeOptions {
  depth?: number;
  movetime?: number;
  multipv?: number;
}

export interface Engine {
  load(): Promise<void>;
  setOptions(options: Record<string, string | number | boolean>): Promise<void>;
  analyze(fen: string, opts: AnalyzeOptions): AsyncIterable<EngineInfo>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
