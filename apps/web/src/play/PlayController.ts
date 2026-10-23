import type { AnalyzeOptions, BestMove, EngineInfo } from '@chesslab/engine-core';
import { currentFen, turn, type GameStore, type Orientation } from '../store/gameStore';
import { atTip, gameOutcome, type Outcome } from './outcome';
import { strengthOptions, type StrengthPreset } from './strength';

/** The engine surface the controller needs ({@link WasmEngineClient} implements it). */
export interface PlayEngine {
  load(): Promise<void>;
  setOptions(options: Record<string, string | number | boolean>): Promise<void>;
  analyze(
    fen: string,
    opts: AnalyzeOptions,
  ): AsyncIterable<EngineInfo> & { readonly bestMove?: Promise<BestMove | null> };
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export type CreatePlayEngine = () => PlayEngine | Promise<PlayEngine>;

/** The part of the zustand game store API the controller uses. */
export interface GameStoreApi {
  getState(): GameStore;
  subscribe(listener: (state: GameStore, prev: GameStore) => void): () => void;
}

export interface PlayConfig {
  playerColor: Orientation;
  strength: StrengthPreset;
  /** Thinking time per move in ms. */
  moveTime: number;
  /**
   * With a clock: the thinking time for the search that starts now (read when the search starts,
   * replaces `moveTime`). The extra reply delay is skipped then, it would cost the engine's clock.
   */
  searchTime?: () => number;
}

export interface PlayControllerOptions {
  game: GameStoreApi;
  createEngine: CreatePlayEngine;
  /** Extra pause before the engine's move is played, so replies do not feel instant. */
  extraDelayMs?: () => number;
  /** The engine is disposed this long after the game stopped (unless a new game starts). */
  idleDisposeMs?: number;
  onThinking(thinking: boolean): void;
  /** A search starts now (after the engine is loaded and configured). */
  onSearchStart?(): void;
  /** The engine has its move (it is played now, or once the view is back at the tip). */
  onMoveReady?(): void;
  onGameOver(outcome: Outcome): void;
  onError(message: string): void;
}

export const IDLE_DISPOSE_MS = 30_000;
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

const defaultDelay = (): number => Math.random() * 300;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Drives the engine side of a "Play vs Engine" game.
 *
 * While active it subscribes to the game store and, whenever the tip of the game has the engine
 * to move, searches that position for `moveTime` ms and plays `bestmove` (fallback: `pv[0]` of the
 * last info) through `makeMove`.
 *
 * Guards:
 * - Generation counter: every search, cancellation (takeback, stop, position change) bumps it;
 *   a result is only used when its generation is still current.
 * - The engine always searches the **tip** of the game. If the user is viewing an earlier ply
 *   when the result arrives, the move is held and played once the view returns to the tip;
 *   `makeMove` is never called on a non-tip position (it would truncate the game).
 * - A result is dropped unless the tip FEN still equals the searched FEN.
 * - Game over (mate, stalemate, insufficient material, 50 moves, threefold) ends the game; engine
 *   failures end it with an error. Only one search runs at a time.
 */
export class PlayController {
  private readonly opts: PlayControllerOptions;
  private config: PlayConfig | null = null;
  private unsubscribe: (() => void) | null = null;
  private gen = 0;
  /** Tip FEN the engine is thinking on (or holding a move for). */
  private searchFen: string | null = null;
  private searching = false;
  private held: { fen: string; uci: string } | null = null;
  private thinking = false;

  private engine: PlayEngine | null = null;
  private enginePromise: Promise<PlayEngine> | null = null;
  private engineEpoch = 0;
  private appliedOptions: string | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PlayControllerOptions) {
    this.opts = opts;
  }

  get active(): boolean {
    return this.config !== null;
  }

  get isThinking(): boolean {
    return this.thinking;
  }

  /** Starts (or restarts) driving the engine with `config`. */
  start(config: PlayConfig): void {
    this.clearDisposeTimer();
    this.cancel();
    this.config = config;
    this.unsubscribe ??= this.opts.game.subscribe(() => this.evaluate());
    this.evaluate();
  }

  /** Stops driving the engine; the engine is disposed after {@link IDLE_DISPOSE_MS}. */
  stop(): void {
    if (!this.config) return;
    this.config = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancel();
    this.scheduleDispose();
  }

  /** Drops the running search or held move (e.g. on takeback). */
  cancel(): void {
    this.gen++;
    this.searchFen = null;
    this.held = null;
    if (this.searching) {
      this.searching = false;
      void this.engine?.stop().catch(() => undefined);
    }
    this.setThinking(false);
  }

  /** Stops and terminates the engine now (pagehide, tests). The controller stays reusable. */
  async dispose(): Promise<void> {
    this.stop();
    this.clearDisposeTimer();
    await this.disposeEngine();
  }

  /** Re-checks the game; called on every game store change while active. */
  private evaluate(): void {
    const config = this.config;
    if (!config) return;
    const s = this.opts.game.getState();
    const outcome = gameOutcome(s);
    if (outcome) {
      this.stop();
      this.opts.onGameOver(outcome);
      return;
    }
    const tip = atTip(s);
    if (turn(tip) === config.playerColor) {
      if (this.searchFen !== null) this.cancel();
      return;
    }
    const tipFen = currentFen(tip);
    if (this.searchFen === tipFen) {
      this.tryPlayHeld();
      return;
    }
    if (this.searchFen !== null) this.cancel();
    this.think(tipFen, config);
  }

  private think(fen: string, config: PlayConfig): void {
    const gen = ++this.gen;
    this.searchFen = fen;
    this.held = null;
    this.setThinking(true);
    void (async () => {
      try {
        const engine = await this.getEngine();
        if (gen !== this.gen) return;
        await this.applyOptions(engine, strengthOptions(config.strength));
        if (gen !== this.gen) return;
        this.searching = true;
        this.opts.onSearchStart?.();
        const movetime = config.searchTime ? config.searchTime() : config.moveTime;
        const handle = engine.analyze(fen, { movetime: Math.max(1, Math.round(movetime)) });
        let pv0: string | undefined;
        try {
          for await (const info of handle) {
            if (gen !== this.gen) break;
            if (info.multipv === 1 && info.pv[0]) pv0 = info.pv[0];
          }
        } finally {
          if (gen === this.gen) this.searching = false;
        }
        if (gen !== this.gen) return;
        const best = (await handle.bestMove)?.move ?? pv0;
        if (gen !== this.gen) return;
        if (!best || !UCI_MOVE.test(best)) throw new Error('The engine returned no move');
        const delay = config.searchTime ? 0 : (this.opts.extraDelayMs ?? defaultDelay)();
        if (delay > 0) {
          await sleep(delay);
          if (gen !== this.gen) return;
        }
        this.held = { fen, uci: best };
        this.opts.onMoveReady?.();
        this.tryPlayHeld();
      } catch (err) {
        if (gen === this.gen) this.fail(err);
      }
    })();
  }

  /** Plays the held engine move if the view is at the tip and the tip is still the searched one. */
  private tryPlayHeld(): void {
    const h = this.held;
    if (!h || !this.config) return;
    const s = this.opts.game.getState();
    if (s.ply !== s.moves.length) return; // the user is looking at an earlier position
    if (currentFen(s) !== h.fen) {
      this.cancel();
      return;
    }
    this.held = null;
    this.searchFen = null;
    this.setThinking(false);
    const { uci } = h;
    const ok = s.makeMove(uci.slice(0, 2), uci.slice(2, 4), uci[4]);
    if (!ok) this.fail(new Error(`The engine played an illegal move (${uci})`));
  }

  private fail(err: unknown): void {
    this.stop();
    this.clearDisposeTimer();
    // A failed engine is not reused.
    void this.disposeEngine();
    this.opts.onError(message(err));
  }

  private setThinking(v: boolean): void {
    if (this.thinking === v) return;
    this.thinking = v;
    this.opts.onThinking(v);
  }

  private getEngine(): Promise<PlayEngine> {
    if (this.enginePromise) return this.enginePromise;
    const epoch = this.engineEpoch;
    const p = (async () => {
      const e = await this.opts.createEngine();
      if (epoch !== this.engineEpoch) {
        void e.dispose().catch(() => undefined);
        throw new Error('Engine has been disposed');
      }
      this.engine = e;
      await e.load();
      return e;
    })();
    this.enginePromise = p;
    p.catch(() => {
      if (this.enginePromise !== p) return;
      // Retry with a fresh engine next time.
      void this.disposeEngine();
    });
    return p;
  }

  private async applyOptions(
    engine: PlayEngine,
    options: Record<string, string | number | boolean>,
  ): Promise<void> {
    const key = JSON.stringify(options);
    if (key === this.appliedOptions) return;
    await engine.setOptions(options);
    this.appliedOptions = key;
  }

  private async disposeEngine(): Promise<void> {
    this.engineEpoch++;
    const e = this.engine;
    this.engine = null;
    this.enginePromise = null;
    this.appliedOptions = null;
    this.searching = false;
    if (e) await e.dispose().catch(() => undefined);
  }

  private scheduleDispose(): void {
    this.clearDisposeTimer();
    const ms = this.opts.idleDisposeMs ?? IDLE_DISPOSE_MS;
    this.disposeTimer = setTimeout(() => {
      this.disposeTimer = null;
      if (!this.config) void this.disposeEngine();
    }, ms);
  }

  private clearDisposeTimer(): void {
    if (this.disposeTimer !== null) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
  }
}
