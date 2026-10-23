/** Evaluation from White's perspective: centipawns or moves-to-mate (negative = Black mates). */
export type Score = { cp: number } | { mate: number };

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
