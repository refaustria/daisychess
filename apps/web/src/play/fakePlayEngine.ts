import type { AnalyzeOptions, BestMove, EngineInfo } from '@daisychess/engine-core';
import { Chess } from 'chess.js';
import type { PlayEngine } from './PlayController';

/** First legal move in UCI notation (deterministic default for the fake engine). */
export function firstLegalMove(fen: string): string | null {
  const m = new Chess(fen).moves({ verbose: true })[0];
  return m ? `${m.from}${m.to}${m.promotion ?? ''}` : null;
}

interface Waiting {
  fen: string;
  release(stopped: boolean): void;
}

/** Scriptable {@link PlayEngine} for tests. */
export class FakePlayEngine implements PlayEngine {
  loadCalls = 0;
  stopCalls = 0;
  disposed = false;
  readonly options: Record<string, string | number | boolean>[] = [];
  readonly searches: { fen: string; opts: AnalyzeOptions }[] = [];
  active = 0;
  maxActive = 0;
  /** Searches wait for {@link release} (or `stop()`) when true. */
  manual = false;
  /** The move to answer with (null = none). */
  pickMove: (fen: string) => string | null = firstLegalMove;
  /** Resolve `bestMove` with null (the controller must fall back to the info pv). */
  noBestMove = false;
  failSearch: Error | null = null;
  failLoad: Error | null = null;
  private waiting: Waiting[] = [];

  async load(): Promise<void> {
    this.loadCalls++;
    if (this.failLoad) throw this.failLoad;
  }

  async setOptions(options: Record<string, string | number | boolean>): Promise<void> {
    this.options.push(options);
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    const w = this.waiting;
    this.waiting = [];
    for (const x of w) x.release(true);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  /** Lets waiting searches finish normally. */
  release(): void {
    const w = this.waiting;
    this.waiting = [];
    for (const x of w) x.release(false);
  }

  get pending(): number {
    return this.waiting.length;
  }

  analyze(
    fen: string,
    opts: AnalyzeOptions,
  ): AsyncIterable<EngineInfo> & { bestMove: Promise<BestMove | null> } {
    this.searches.push({ fen, opts });
    let finish!: (b: BestMove | null) => void;
    const bestMove = new Promise<BestMove | null>((r) => (finish = r));
    const run = async function* (self: FakePlayEngine): AsyncGenerator<EngineInfo> {
      self.active++;
      self.maxActive = Math.max(self.maxActive, self.active);
      try {
        if (self.failSearch) throw self.failSearch;
        let stopped = false;
        if (self.manual) {
          stopped = await new Promise<boolean>((r) => self.waiting.push({ fen, release: r }));
        }
        if (stopped) {
          finish(null);
          return;
        }
        const move = self.pickMove(fen);
        if (move) yield { depth: 1, multipv: 1, score: { cp: 0 }, pv: [move] };
        finish(self.noBestMove || !move ? null : { move });
      } finally {
        self.active--;
        finish(null);
      }
    };
    const it = run(this);
    return { bestMove, [Symbol.asyncIterator]: () => it };
  }
}
