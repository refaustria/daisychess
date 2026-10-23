import type { AnalyzeOptions, BestMove, Engine, EngineInfo, Score } from '@chesslab/engine-core';

export interface Script {
  score: Score;
  pv?: string[];
  /** `bestmove` reported by the handle; defaults to `pv[0]`. `null` = no bestMove promise value. */
  bestMove?: string | null;
}

/**
 * Scriptable in-memory {@link Engine} for review tests. Each search yields one info per
 * configured FEN (default `{cp: 0}`), optionally after `delayMs`, or hangs until `stop()` when
 * `hang` contains the FEN.
 */
export class FakeReviewEngine implements Engine {
  readonly scripts = new Map<string, Script>();
  readonly analysed: string[] = [];
  readonly calls: AnalyzeOptions[] = [];
  readonly hang = new Set<string>();
  readonly fail = new Map<string, Error>();
  stopCalls = 0;
  loadCalls = 0;
  disposed = false;
  /** Searches started but not yet finished. */
  active = 0;
  maxActive = 0;
  delayMs = 0;
  private stopCurrent: (() => void) | null = null;

  async load(): Promise<void> {
    this.loadCalls++;
  }
  async setOptions(): Promise<void> {}
  async dispose(): Promise<void> {
    this.disposed = true;
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    this.stopCurrent?.();
    await Promise.resolve();
  }

  analyze(
    fen: string,
    opts: AnalyzeOptions,
  ): AsyncIterable<EngineInfo> & { bestMove: Promise<BestMove | null> } {
    this.analysed.push(fen);
    this.calls.push(opts);
    const script = this.scripts.get(fen) ?? { score: { cp: 0 }, pv: ['e2e4'] };
    const pv = script.pv ?? ['e2e4'];
    let resolveBest!: (b: BestMove | null) => void;
    const bestMove = new Promise<BestMove | null>((r) => (resolveBest = r));
    const it = this.search(fen, script, pv, resolveBest);
    return { bestMove, [Symbol.asyncIterator]: () => it };
  }

  private async *search(
    fen: string,
    script: Script,
    pv: string[],
    resolveBest: (b: BestMove | null) => void,
  ): AsyncGenerator<EngineInfo> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      let stopped = false;
      const stoppedP = new Promise<void>((r) => {
        this.stopCurrent = () => {
          stopped = true;
          r();
        };
      });
      if (this.delayMs > 0)
        await Promise.race([new Promise((r) => setTimeout(r, this.delayMs)), stoppedP]);
      if (this.hang.has(fen) && !stopped) await stoppedP;
      const err = this.fail.get(fen);
      if (err) throw err;
      yield { depth: 1, multipv: 1, score: { cp: 12345 }, pv: ['a2a3'] };
      if (stopped) return;
      yield { depth: 10, multipv: 1, score: script.score, pv };
      resolveBest(script.bestMove === null ? null : { move: script.bestMove ?? pv[0]! });
    } finally {
      this.active--;
      this.stopCurrent = null;
      resolveBest(null);
    }
  }
}
