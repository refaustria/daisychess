/**
 * Stage 2 generation (ADR-023 §9, M30-10): turns the mistakes of the user's reviewed games into
 * puzzles. Runs only on demand ("Find puzzles in my games" in "Your mistakes"), never after a
 * review.
 *
 * Queue: the ledger games with a known user side (most recently reviewed first). Per game the
 * review comes from the local review cache, else — when a server is configured **and** an access
 * token is set — from the server review store (`review.get`). `mistakeCandidates` lists the
 * user's mistakes/blunders; candidates already stored or handled by an earlier scan (the game's
 * scan marker in the `mistakes` store) are skipped without a search. Each remaining candidate is
 * driven through the pure `cutSolution` step function: every `search` decision runs one engine
 * search with `multipv` (browser: 1,000 ms for the start position, 500 ms otherwise; server:
 * depth 16), at most {@link CUT_LIMITS.maxSearches} per candidate; an accepted puzzle is stored
 * at once with a new (due) schedule.
 *
 * Engine (ADR-015): one {@link openSearchEngine} lease per run — the server session when
 * configured, else the pooled browser engine, which is leased per search, so a running review
 * makes the generator wait ("Waiting for the running review to finish…", the search timeout is
 * paused meanwhile) and no extra WASM instance is ever created. The live analysis is paused while
 * the run uses the browser engine. Failures are handled like the drill's checks: a failing server
 * falls back to the browser once (with the review's notice), a browser engine that ran out of
 * memory is retried once (the pool recreates it degraded), a browser engine disabled for the
 * session hands over to the server once when allowed; otherwise the run stops with a message.
 *
 * Pauses (M26-4): when the app goes to the background (`pagehide` from the lifecycle) or a
 * human game starts (fair play, `humanGameLockReason`), the running search is stopped and the lease released; the run continues where it was after `pageshow` / the end of
 * the game. Cancel stops the search at once; puzzles found so far stay stored. The run yields to
 * the event loop between candidates so the UI stays responsive.
 */
import { Chess } from 'chess.js';
import { create } from 'zustand';
import {
  scoreToWhitePov,
  sideToMove,
  type AnalyzeOptions,
  type BestMove,
  type Engine,
  type EngineInfo,
} from '@daisychess/engine-core';
import {
  CUT_LIMITS,
  cutSolution,
  mistakeCandidates,
  type CutSkipReason,
  type MistakeCandidate,
  type SearchLine,
  type SearchPurpose,
  type SearchResult,
} from '@daisychess/puzzles';
import { pauseAnalysis } from '../engine/analysisPause';
import { isRetryableEngineError, wasmHealth } from '../engine/wasmHealth';
import { humanGameLockReason, lockText } from '../live/lock';
import { useLiveStore } from '../live/liveStore';
import { usePlayStore } from '../play/playStore';
import { useRoomStore } from '../room/roomStore';
import type { BatchGame, BatchMove } from '../review/BatchAnalyzer';
import { getStoredReview, type StoredReview } from '../review/reviewCache';
import {
  openSearchEngine,
  reportSearchServerFailure,
  serverConfigured,
  type SearchEngineLease,
} from '../review/reviewStore';
import { fetchServerReview, serverStoreAvailable } from '../review/serverReviewStore';
import { useSettingsStore } from '../store/settingsStore';
import { listGames, type LedgerGame } from './gameLedger';
import {
  addMistakes,
  getScanMarker,
  listMistakes,
  markScanned,
  newSchedule,
  pruneScanMarkers,
  type MistakeRecord,
} from './mistakeStore';

// ---------------------------------------------------------------------------------------------
// Types

/** Search budgets (ADR-023 §9). */
export const MISTAKE_SEARCH = {
  /** Browser: the mistake position. */
  startMs: 1000,
  /** Browser: opponent replies and the final position. */
  replyMs: 500,
  /** Server: every search. */
  serverDepth: 16,
} as const;

/** A search that runs longer than this (not counting the wait for the shared engine) fails. */
export const SEARCH_TIMEOUT_MS = 30_000;
/** Engine failures in a row (after the fallbacks) that end the run. */
export const MAX_CONSECUTIVE_FAILURES = 3;

export const WAITING_NOTICE = 'Waiting for the running review to finish…';
export const BACKGROUND_NOTICE = 'Paused while the app is in the background';

export type GenerationStatus = 'idle' | 'running' | 'paused' | 'done' | 'cancelled' | 'failed';

/** Why a candidate produced no puzzle (the cut's reasons, plus engine failures). */
export type CandidateSkip = CutSkipReason | 'engine-error';

export interface GenerationProgress {
  /** Games in the queue (with a known side). */
  gamesTotal: number;
  /** Games finished (scanned, or without a review). */
  gamesDone: number;
  /** The game being scanned. */
  current?: { gameKey: string; white?: string; black?: string };
  /** Candidates to search in the current game (after dedupe). */
  candidatesTotal: number;
  candidatesDone: number;
  /** Engine searches so far (whole run). */
  searches: number;
  /** New puzzles stored so far. */
  found: number;
  /** Candidates rejected so far. */
  skipped: number;
}

export interface GenerationResult {
  status: 'done' | 'cancelled' | 'failed';
  /** New puzzles stored by this run. */
  added: MistakeRecord[];
  /** Rejected candidates by reason. */
  skipped: Partial<Record<CandidateSkip, number>>;
  /** Games scanned (review found). */
  gamesScanned: number;
  /** Games whose review is neither cached locally nor available from the server. */
  gamesWithoutReview: string[];
  searches: number;
  /** Failure message (`failed`). */
  error?: string;
}

export interface GenerateOptions {
  signal?: AbortSignal;
  onProgress?: (p: GenerationProgress) => void;
  /** Engine notice (fallback, waiting, paused); undefined clears it. */
  onNotice?: (notice: string | undefined) => void;
  /** Called with `true` while the run is paused (background, human game), `false` after. */
  onPause?: (paused: boolean) => void;
  /** Only these ledger games (default: all with a known side). */
  gameKeys?: readonly string[];
  /** Search candidates of earlier scans again (stored puzzles are still never duplicated). */
  rescan?: boolean;
}

/** Why the run must wait: a notice text, or undefined to go on. */
export interface PauseSource {
  reason(): string | undefined;
  /** Calls `cb` whenever the reason may have changed. Returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
}

export interface GeneratorHooks {
  openEngine: (
    pref: 'server' | 'browser' | undefined,
    onWait: (waiting: boolean) => void,
  ) => Promise<SearchEngineLease>;
  /** Server failure of a lease → notice (see `reportSearchServerFailure`). */
  reportServerFailure: (err: unknown) => string | undefined;
  /** The browser engine failed for good: may the run switch to the server? */
  canUseServer: () => boolean;
  browserDisabled: () => boolean;
  listGames: () => Promise<LedgerGame[]>;
  localReview: (gameKey: string) => Promise<StoredReview | undefined>;
  /** The server's review of a ledger game (undefined without server or token). */
  serverReview: (game: LedgerGame) => Promise<StoredReview | undefined>;
  /** Pauses the live analysis; returns the release. */
  pauseAnalysis: (active: () => boolean) => () => void;
  pauseSource: () => PauseSource;
  yieldToUi: () => Promise<void>;
  now: () => number;
  searchTimeoutMs: number;
}

// ---------------------------------------------------------------------------------------------
// Default hooks

const BROWSER_TEXT = /reviewing in the browser/g;
const generatorNotice = (n: string | undefined): string | undefined =>
  n?.replace(BROWSER_TEXT, 'searching in the browser');

/** True when the server store may be read for evicted reviews: configured and a token is set. */
export function serverReviewsUsable(): boolean {
  return serverStoreAvailable() && useSettingsStore.getState().serverToken !== '';
}

/** The ledger game as the review analyser's game (SAN replayed); undefined if illegal. */
export function ledgerBatchGame(
  game: Pick<LedgerGame, 'startFen' | 'moves'>,
): BatchGame | undefined {
  try {
    const chess = new Chess(game.startFen);
    const moves: BatchMove[] = [];
    for (const san of game.moves) {
      const m = chess.move(san);
      moves.push({
        uci: `${m.from}${m.to}${m.promotion ?? ''}`,
        san: m.san,
        fenAfter: chess.fen(),
      });
    }
    return { startFen: game.startFen, moves };
  } catch {
    return undefined;
  }
}

async function defaultServerReview(game: LedgerGame): Promise<StoredReview | undefined> {
  if (!serverReviewsUsable()) return undefined;
  const batch = ledgerBatchGame(game);
  return batch ? fetchServerReview(batch, game.gameKey) : undefined;
}

/**
 * Background (the lifecycle's `pagehide`/`pageshow`, M26-4: dispatched when the native app goes
 * to the background and comes back) and human-game locks. A hidden browser tab does not pause:
 * the user may well wait for the run in another tab.
 */
export function defaultPauseSource(): PauseSource {
  let hidden = false;
  return {
    reason: () => {
      if (hidden) return BACKGROUND_NOTICE;
      const lock = humanGameLockReason();
      return lock ? (lockText(lock) ?? 'Paused while a game runs') : undefined;
    },
    subscribe: (cb) => {
      const offs: (() => void)[] = [];
      if (typeof window !== 'undefined') {
        const hide = () => {
          hidden = true;
          cb();
        };
        const show = () => {
          hidden = false;
          cb();
        };
        window.addEventListener('pagehide', hide);
        window.addEventListener('pageshow', show);
        offs.push(() => window.removeEventListener('pagehide', hide));
        offs.push(() => window.removeEventListener('pageshow', show));
      }
      offs.push(usePlayStore.subscribe(cb), useLiveStore.subscribe(cb), useRoomStore.subscribe(cb));
      return () => offs.forEach((off) => off());
    },
  };
}

export const DEFAULT_GENERATOR_HOOKS: GeneratorHooks = {
  openEngine: (pref, onWait) => openSearchEngine(pref, { onWait }),
  reportServerFailure: (err) => reportSearchServerFailure(err),
  canUseServer: () => serverConfigured() && useSettingsStore.getState().reviewEngine !== 'browser',
  browserDisabled: () => wasmHealth().disabled !== undefined,
  listGames,
  localReview: getStoredReview,
  serverReview: defaultServerReview,
  pauseAnalysis,
  pauseSource: defaultPauseSource,
  yieldToUi: () => new Promise((r) => setTimeout(r, 0)),
  now: Date.now,
  searchTimeoutMs: SEARCH_TIMEOUT_MS,
};

// ---------------------------------------------------------------------------------------------
// Errors

class PausedError extends Error {
  constructor() {
    super('paused');
    this.name = 'PausedError';
  }
}

const abortError = (): Error => {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
};

class FatalError extends Error {}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------------------------
// Search

type Handle = AsyncIterable<EngineInfo> & { readonly bestMove?: Promise<BestMove | null> };

/** Score (White POV, as every engine client reports it) seen from the side to move of `fen`. */
const toStm = (fen: string, info: EngineInfo): SearchLine['score'] =>
  scoreToWhitePov(info.score, sideToMove(fen)); // the conversion is its own inverse

/**
 * The lines of a finished `multipv` search: the deepest depth at which every reported line is
 * present (a stopped search may end in the middle of a depth). The best line keeps a longer PV of
 * an earlier info when the last one is a truncated prefix of it.
 */
export function collectLines(
  fen: string,
  infos: readonly EngineInfo[],
  multipv: number,
): SearchLine[] {
  const byDepth = new Map<number, Map<number, EngineInfo>>();
  let width = 0;
  let longestBest: readonly string[] = [];
  for (const info of infos) {
    const m = info.multipv ?? 1;
    if (m < 1 || m > multipv || info.pv.length === 0) continue;
    width = Math.max(width, m);
    let at = byDepth.get(info.depth);
    if (!at) byDepth.set(info.depth, (at = new Map()));
    at.set(m, info);
    if (m === 1 && info.pv.length > longestBest.length) longestBest = info.pv;
  }
  const depths = [...byDepth.keys()].sort((a, b) => b - a);
  const depth = depths.find((d) => byDepth.get(d)!.size >= width);
  if (depth === undefined) return [];
  const at = byDepth.get(depth)!;
  const lines: SearchLine[] = [];
  for (let m = 1; m <= width; m++) {
    const info = at.get(m);
    if (!info) break;
    let pv: readonly string[] = info.pv;
    if (m === 1 && longestBest.length > pv.length && pv.every((mv, i) => longestBest[i] === mv)) {
      pv = longestBest;
    }
    lines.push({ pv: [...pv], score: toStm(fen, info) });
  }
  return lines;
}

/** Search options for a purpose on the given engine. */
export function searchOptions(
  kind: 'server' | 'browser',
  purpose: SearchPurpose,
  multipv: number,
): AnalyzeOptions {
  if (kind === 'server') return { depth: MISTAKE_SEARCH.serverDepth, multipv };
  return {
    movetime: purpose === 'start' ? MISTAKE_SEARCH.startMs : MISTAKE_SEARCH.replyMs,
    multipv,
  };
}

/**
 * Owns the run's engine lease and runs single searches with timeout, cancel/pause and the drill's
 * fallbacks.
 */
class SearchRunner {
  private lease: Promise<SearchEngineLease> | null = null;
  private serverTried = false;
  private releaseAnalysis: (() => void) | null = null;
  /** Running-time deadline of the current search (paused while waiting for the pool). */
  private deadline: { pause(): void; resume(): void } | null = null;
  private noticeBeforeWait: string | undefined;
  notice: string | undefined;
  searches = 0;

  constructor(
    private readonly hooks: GeneratorHooks,
    private readonly setNotice: (n: string | undefined) => void,
    private readonly interrupt: () => AbortSignal,
    private readonly running: () => boolean,
  ) {}

  private showNotice(n: string | undefined): void {
    this.notice = n;
    this.setNotice(n);
  }

  private readonly onWait = (waiting: boolean): void => {
    if (waiting) {
      this.deadline?.pause();
      this.noticeBeforeWait = this.notice;
      this.setNotice(WAITING_NOTICE);
    } else {
      this.setNotice(this.noticeBeforeWait);
      this.noticeBeforeWait = undefined;
      this.deadline?.resume();
    }
  };

  private open(
    pref: 'server' | 'browser' | undefined,
    notice?: string,
  ): Promise<SearchEngineLease> {
    const p = this.hooks.openEngine(pref, this.onWait).then((l) => {
      this.showNotice(notice ?? generatorNotice(l.notice));
      if (l.runsOn.kind === 'browser') {
        this.releaseAnalysis ??= this.hooks.pauseAnalysis(this.running);
      }
      return l;
    });
    this.lease = p;
    p.catch(() => {
      if (this.lease === p) this.lease = null;
    });
    return p;
  }

  private getLease(): Promise<SearchEngineLease> {
    return this.lease ?? this.open(undefined);
  }

  /** Gives the lease back (pause, end of run); the next search opens a new one. */
  async release(): Promise<void> {
    const l = this.lease;
    this.lease = null;
    if (l) await l.then((x) => x.dispose()).catch(() => undefined);
  }

  /** End of the run: lease and the live-analysis pause. */
  async dispose(): Promise<void> {
    await this.release();
    this.releaseAnalysis?.();
    this.releaseAnalysis = null;
  }

  /** One search with fallbacks (see the module comment). Throws Paused/Abort/Fatal or the error. */
  async search(fen: string, multipv: number, purpose: SearchPurpose): Promise<SearchResult> {
    const l = await this.getLease();
    try {
      return await this.once(l, fen, multipv, purpose);
    } catch (err) {
      if (err instanceof PausedError || (err as Error).name === 'AbortError') throw err;
      if (l.runsOn.kind === 'server') {
        const notice = generatorNotice(this.hooks.reportServerFailure(err));
        void l.dispose().catch(() => undefined);
        this.lease = null;
        const b = await this.open('browser', notice);
        return this.once(b, fen, multipv, purpose);
      }
      if (isRetryableEngineError(err)) return this.once(l, fen, multipv, purpose);
      if (this.hooks.browserDisabled()) {
        if (!this.serverTried && this.hooks.canUseServer()) {
          this.serverTried = true;
          void l.dispose().catch(() => undefined);
          this.lease = null;
          const s = await this.open('server');
          return this.once(s, fen, multipv, purpose);
        }
        throw new FatalError(
          `Puzzle search stopped: the browser engine is unavailable (${message(err)}).`,
        );
      }
      throw err;
    }
  }

  private async once(
    lease: SearchEngineLease,
    fen: string,
    multipv: number,
    purpose: SearchPurpose,
  ): Promise<SearchResult> {
    const signal = this.interrupt();
    if (signal.aborted) throw signal.reason;
    this.searches++;
    const opts = searchOptions(lease.runsOn.kind, purpose, multipv);
    const engine: Engine = lease.engine;
    const handle = engine.analyze(fen, opts) as Handle;
    const it = handle[Symbol.asyncIterator]();
    const infos: EngineInfo[] = [];

    let fail: (err: unknown) => void = () => undefined;
    const failed = new Promise<never>((_, reject) => (fail = reject));
    failed.catch(() => undefined);
    const onAbort = () => fail(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let left = this.hooks.searchTimeoutMs;
    let since = 0;
    const arm = () => {
      since = Date.now();
      timer = setTimeout(() => fail(new Error('The engine took too long')), left);
    };
    const own = {
      pause: () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        left = Math.max(0, left - (Date.now() - since));
      },
      resume: () => {
        if (timer === undefined) arm();
      },
    };
    this.deadline = own;
    arm();
    try {
      for (;;) {
        const r = await Promise.race([it.next(), failed]);
        if (r.done) break;
        infos.push(r.value);
      }
    } catch (err) {
      // Stop the search; the iterator ends with the engine's `bestmove` and gives the lease back.
      void engine.stop().catch(() => undefined);
      void it.return?.()?.catch(() => undefined);
      throw err;
    } finally {
      clearTimeout(timer);
      timer = undefined;
      if (this.deadline === own) this.deadline = null;
      signal.removeEventListener('abort', onAbort);
    }
    return { fen, lines: collectLines(fen, infos, multipv) };
  }
}

// ---------------------------------------------------------------------------------------------
// Generation

/** Waits until `source` gives no reason any more; rejects on `signal`. */
function waitForResume(source: PauseSource, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const done = () => {
      off();
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(signal.reason);
    };
    const off = source.subscribe(() => {
      if (source.reason() === undefined) {
        done();
        resolve();
      }
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (source.reason() === undefined) {
      done();
      resolve();
    }
  });
}

/** The mistake record of an accepted cut. */
function recordOf(
  c: MistakeCandidate,
  gameKey: string,
  puzzle: MistakeRecord['puzzle'],
  now: number,
): MistakeRecord {
  return {
    id: c.id,
    puzzle,
    gameKey,
    ply: c.ply,
    playedUci: c.playedUci,
    classification: c.classification,
    evalBeforeWhite: c.evalBeforeWhite,
    evalAfterWhite: c.evalAfterWhite,
    createdAt: now,
    schedule: newSchedule(now),
  };
}

const sameMoves = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((m, i) => m === b[i]);

/**
 * Runs one generation over the ledger (see the module comment). Resolves (never rejects) with
 * the result; puzzles are stored as they are found, so a cancelled or failed run keeps them.
 */
export async function generateMistakePuzzles(
  opts: GenerateOptions = {},
  hooks: GeneratorHooks = DEFAULT_GENERATOR_HOOKS,
): Promise<GenerationResult> {
  const external = opts.signal;
  const added: MistakeRecord[] = [];
  const skipped: Partial<Record<CandidateSkip, number>> = {};
  const gamesWithoutReview: string[] = [];
  let gamesScanned = 0;
  let running = true;
  const progress: GenerationProgress = {
    gamesTotal: 0,
    gamesDone: 0,
    candidatesTotal: 0,
    candidatesDone: 0,
    searches: 0,
    found: 0,
    skipped: 0,
  };
  const emit = () => {
    try {
      opts.onProgress?.({
        ...progress,
        ...(progress.current ? { current: { ...progress.current } } : {}),
      });
    } catch {
      // A failing listener must not end the run.
    }
  };
  const skip = (reason: CandidateSkip) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
    progress.skipped++;
  };

  // Interrupt = the caller's cancel or a pause (background, human game).
  const source = hooks.pauseSource();
  let interrupt = new AbortController();
  const cancel = new AbortController();
  const onCancel = () => {
    cancel.abort(abortError());
    interrupt.abort(abortError());
  };
  if (external?.aborted) onCancel();
  else external?.addEventListener('abort', onCancel, { once: true });
  const unsubscribe = source.subscribe(() => {
    if (source.reason() !== undefined && !interrupt.signal.aborted)
      interrupt.abort(new PausedError());
  });

  const runner = new SearchRunner(
    hooks,
    // A late `onWait(false)` from a disposed pooled engine must not touch a finished run.
    (n) => {
      if (running) opts.onNotice?.(n);
    },
    () => interrupt.signal,
    () => running,
  );

  /** Waits while paused (lease released meanwhile); throws AbortError on cancel. */
  const gate = async (): Promise<void> => {
    if (cancel.signal.aborted) throw cancel.signal.reason;
    const reason = source.reason();
    if (reason === undefined && !interrupt.signal.aborted) return;
    if (reason !== undefined) {
      await runner.release();
      opts.onPause?.(true);
      opts.onNotice?.(reason);
      try {
        await waitForResume(source, cancel.signal);
      } finally {
        opts.onPause?.(false);
      }
      opts.onNotice?.(runner.notice);
    }
    interrupt = new AbortController();
    if (cancel.signal.aborted) interrupt.abort(cancel.signal.reason);
  };

  let status: GenerationResult['status'] = 'done';
  let error: string | undefined;
  try {
    const ledger = await hooks.listGames();
    if (!opts.gameKeys) await pruneScanMarkers(new Set(ledger.map((g) => g.gameKey)));
    const only = opts.gameKeys ? new Set(opts.gameKeys) : undefined;
    const queue = ledger.filter(
      (g) => g.userSide !== undefined && !g.sideSkipped && (!only || only.has(g.gameKey)),
    );
    const known = new Set((await listMistakes()).map((m) => m.id));
    progress.gamesTotal = queue.length;
    emit();

    let failures = 0;
    for (const game of queue) {
      await gate();
      progress.current = {
        gameKey: game.gameKey,
        ...(game.headers.White ? { white: game.headers.White } : {}),
        ...(game.headers.Black ? { black: game.headers.Black } : {}),
      };
      progress.candidatesTotal = 0;
      progress.candidatesDone = 0;
      emit();

      let review = await hooks.localReview(game.gameKey);
      if (review && !sameMoves(review.moves, game.moves)) review = undefined;
      if (!review) {
        review = await hooks.serverReview(game);
        if (review && !sameMoves(review.moves, game.moves)) review = undefined;
      }
      if (cancel.signal.aborted) throw cancel.signal.reason;
      if (!review) {
        gamesWithoutReview.push(game.gameKey);
        progress.gamesDone++;
        emit();
        continue;
      }
      gamesScanned++;
      const marker = opts.rescan ? undefined : await getScanMarker(game.gameKey);
      const handled = new Set(marker?.ids ?? []);
      const candidates = mistakeCandidates(review, game.userSide!).filter(
        (c) => !known.has(c.id) && !handled.has(c.id),
      );
      progress.candidatesTotal = candidates.length;
      emit();
      if (candidates.length === 0)
        await markScanned(game.gameKey, review.createdAt, [], hooks.now());

      for (const c of candidates) {
        await hooks.yieldToUi();
        await gate();
        const results: SearchResult[] = [];
        let outcome: 'accepted' | 'skipped' | 'error' | undefined;
        // A pause interrupts a search: the finished searches are kept and the step repeats.
        for (let steps = 0; steps <= CUT_LIMITS.maxSearches + 1; steps++) {
          const d = cutSolution(c, results);
          if (d.type === 'skip') {
            skip(d.reason);
            known.add(c.id); // the same position in another game of this run: no new search
            outcome = 'skipped';
            break;
          }
          if (d.type === 'accept') {
            const now = hooks.now();
            const stored = await addMistakes([recordOf(c, game.gameKey, d.puzzle, now)], now);
            added.push(...stored);
            known.add(c.id);
            progress.found += stored.length;
            outcome = 'accepted';
            break;
          }
          try {
            results.push(await runner.search(d.fen, d.multipv, d.purpose));
            failures = 0;
          } catch (err) {
            if (err instanceof PausedError) {
              steps--;
              await gate();
              continue;
            }
            if ((err as Error).name === 'AbortError' || err instanceof FatalError) throw err;
            failures++;
            console.warn('Mistake puzzles: search failed', err);
            if (failures >= MAX_CONSECUTIVE_FAILURES) {
              throw new FatalError(`Puzzle search stopped: the engine failed (${message(err)}).`);
            }
            skip('engine-error');
            outcome = 'error';
            break;
          } finally {
            progress.searches = runner.searches;
          }
        }
        if (outcome === undefined) {
          // Defensive: the step function always decides within its budget.
          skip('budget');
          outcome = 'skipped';
        }
        // Engine errors are not remembered: the candidate is tried again on the next run.
        if (outcome !== 'error')
          await markScanned(game.gameKey, review.createdAt, [c.id], hooks.now());
        progress.candidatesDone++;
        emit();
      }
      progress.gamesDone++;
      emit();
    }
  } catch (err) {
    if (cancel.signal.aborted || (err as Error).name === 'AbortError') status = 'cancelled';
    else {
      status = 'failed';
      error = err instanceof FatalError ? err.message : `Puzzle search failed: ${message(err)}`;
    }
  } finally {
    running = false;
    unsubscribe();
    external?.removeEventListener('abort', onCancel);
    await runner.dispose();
    delete progress.current;
    progress.searches = runner.searches;
    emit();
  }
  return {
    status,
    added,
    skipped,
    gamesScanned,
    gamesWithoutReview,
    searches: runner.searches,
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Store (for "Your mistakes", M30-11)

export interface MistakeGenState {
  status: GenerationStatus;
  progress?: GenerationProgress;
  /** Engine notice (fallback, waiting, paused reason). */
  notice?: string;
  /** Result of the last finished run. */
  result?: GenerationResult;
}

export const useMistakeGenStore = create<MistakeGenState>()(() => ({ status: 'idle' }));

let currentRun: { promise: Promise<GenerationResult>; controller: AbortController } | null = null;
let storeHooks: GeneratorHooks = DEFAULT_GENERATOR_HOOKS;

/**
 * Starts "Find puzzles in my games" (one run at a time: while one runs, resolves with the running
 * one's result). Progress, notices and the result are in {@link useMistakeGenStore}.
 */
export function findMistakePuzzles(
  opts: Pick<GenerateOptions, 'gameKeys' | 'rescan'> = {},
): Promise<GenerationResult> {
  if (currentRun) return currentRun.promise;
  const controller = new AbortController();
  useMistakeGenStore.setState({ status: 'running', progress: undefined, notice: undefined }, false);
  const promise = generateMistakePuzzles(
    {
      ...opts,
      signal: controller.signal,
      onProgress: (progress) => useMistakeGenStore.setState({ progress }),
      onNotice: (notice) => useMistakeGenStore.setState({ notice }),
      onPause: (paused) => useMistakeGenStore.setState({ status: paused ? 'paused' : 'running' }),
    },
    storeHooks,
  ).then((result) => {
    currentRun = null;
    useMistakeGenStore.setState({ status: result.status, result, notice: undefined });
    return result;
  });
  currentRun = { promise, controller };
  return promise;
}

/** Cancels the running generation (puzzles found so far stay). */
export function cancelMistakePuzzles(): void {
  currentRun?.controller.abort();
}

/** Test seam: hooks of {@link findMistakePuzzles} (undefined: the defaults); resets the store. */
export function configureMistakeGenerator(hooks?: Partial<GeneratorHooks>): void {
  cancelMistakePuzzles();
  currentRun = null;
  storeHooks = { ...DEFAULT_GENERATOR_HOOKS, ...hooks };
  useMistakeGenStore.setState({
    status: 'idle',
    progress: undefined,
    notice: undefined,
    result: undefined,
  });
}
