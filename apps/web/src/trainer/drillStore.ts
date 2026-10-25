import type { AnalyzeOptions, BestMove, Engine, EngineInfo, Score } from '@daisychess/engine-core';
import { convertPv } from '../engine/pvToSan';
import { humanGameLockReason, lockText } from '../live/lock';
import { useLiveStore } from '../live/liveStore';
import { getBook, type Book, type BookOpening } from '../openings';
import { openingKey, pickWeighted } from '../openings/book';
import { usePlayStore } from '../play/playStore';
import { DEFAULT_STRENGTH, findStrength, HUMAN_PRESETS } from '../play/strength';
import { isRetryableEngineError, wasmHealth } from '../engine/wasmHealth';
import {
  openSearchEngine,
  reportSearchServerFailure,
  serverConfigured,
  type SearchEngineLease,
} from '../review/reviewStore';
import { useSettingsStore } from '../store/settingsStore';
import { useRoomStore } from '../room/roomStore';
import { useAnalysisStore } from '../store/analysisStore';
import { currentFen, useGameStore, type Orientation } from '../store/gameStore';
import { useUiStore } from '../store/uiStore';
import { formatEval, judgeDeviation, resolveSan, sideToMove, terminalScore } from './drill';
import {
  useDrillStore,
  type DrillActions,
  type DrillAfterBook,
  type DrillEndReason,
  type DrillSummary,
} from './drillState';
import {
  dueKeys,
  loadSchedule,
  recordResult,
  saveSchedule,
  type KeyValueStorage,
  type Schedule,
} from './schedule';

/** A search engine the drill owns (a fresh lease per drill, see {@link openSearchEngine}). */
export * from './drillState';

export type CreateDrillEngine = (
  pref?: Parameters<typeof openSearchEngine>[0],
) => Promise<SearchEngineLease>;

export interface DrillHooks {
  createEngine: CreateDrillEngine;
  /** Called on a server failure of the lease; returns the notice (see `reportSearchServerFailure`). */
  reportServerFailure: (err: unknown) => string | undefined;
  /** Pause before a book move of the app. */
  appDelayMs: () => number;
  random: () => number;
  now: () => number;
  storage: KeyValueStorage | undefined;
  /** Search budget per position of an engine check. */
  search: AnalyzeOptions;
  /** A check that takes longer fails (ms). */
  checkTimeoutMs: number;
  /** The book (tests may pass a small one). */
  book: () => Book | null;
  /** The browser engine failed for good: may the drill switch to the engine server? */
  canUseServer: () => boolean;
}

/** Engine check budget: 500 ms per position (two positions per check). */
export const DRILL_SEARCH: AnalyzeOptions = { movetime: 500 };
export const CHECK_TIMEOUT_MS = 20_000;
/** Moves of the engine line shown for a mistake. */
export const PV_MOVES = 4;

const browserStorage = (): KeyValueStorage | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

/** Shown while a check waits for the shared browser engine (a review holds it). */
export const WAITING_NOTICE = 'Waiting for the running review to finish…';

const DEFAULT_HOOKS: DrillHooks = {
  createEngine: (pref) => openSearchEngine(pref, { onWait: onEngineWait }),
  reportServerFailure: (err) => reportSearchServerFailure(err),
  appDelayMs: () => 350 + Math.random() * 250,
  random: Math.random,
  now: Date.now,
  storage: browserStorage(),
  search: DRILL_SEARCH,
  checkTimeoutMs: CHECK_TIMEOUT_MS,
  book: getBook,
  canUseServer: () => serverConfigured() && useSettingsStore.getState().reviewEngine !== 'browser',
};

let hooks: DrillHooks = DEFAULT_HOOKS;
/** Bumped by every state transition that invalidates pending async work (app move, check). */
let gen = 0;
let appTimer: ReturnType<typeof setTimeout> | null = null;
let lease: Promise<SearchEngineLease> | null = null;
let unwatchGame: (() => void) | null = null;
let unwatchLocks: (() => void) | null = null;
let unwatchAnalysis: (() => void) | null = null;
let analysisSuspended = false;
/** True while the drill itself changes the game store (its own subscriber ignores that). */
let applying = false;
/** Plies (index into `line`) where the user made a mistake: not "right first try" any more. */
let failedPlies = new Set<number>();
/** Search results per FEN for the current drill (retries do not search the same position again). */
const evalCache = new Map<string, SearchResult>();
/** Number of drills started (colour alternation for `both`). */
let runs = 0;
/** Timeout of the running check; paused while the check waits for the shared engine. */
let deadline: { pause(): void; resume(): void } | null = null;
/** The drill already switched to the server after the browser engine was disabled. */
let serverTried = false;
/** Engine notice before the "waiting" text replaced it. */
let noticeBeforeWait: string | undefined;
/** Pending automatic continuation after the book ({@link DrillAfterBook}). */
let continueTimer: ReturnType<typeof setTimeout> | null = null;

export const AFTER_BOOK_KEY = 'daisychess.drillAfterBook';

/** A stored/selected "after the book" value, or `stop` for anything unknown. */
export function sanitizeAfterBook(v: unknown): DrillAfterBook {
  if (v === 'stockfish') return 'stockfish';
  if (typeof v === 'string' && HUMAN_PRESETS.some((p) => p.id === v)) return v as DrillAfterBook;
  return 'stop';
}

function loadAfterBook(storage: KeyValueStorage | undefined): DrillAfterBook {
  try {
    return sanitizeAfterBook(storage?.getItem(AFTER_BOOK_KEY));
  } catch {
    return 'stop';
  }
}

/** The Play tab strength id for an "after the book" choice (undefined: the last setup). */
export function afterBookStrength(after: DrillAfterBook): string | undefined {
  if (after === 'stop') return undefined;
  if (after === 'stockfish') {
    // The Play tab's last Stockfish preset, unless the last game was against Maia.
    const last = usePlayStore.getState().setup.strength;
    return findStrength(last).human ? DEFAULT_STRENGTH : last;
  }
  return after;
}

function clearContinue(): void {
  if (continueTimer !== null) clearTimeout(continueTimer);
  continueTimer = null;
}

interface SearchResult {
  score: Score;
  pv: string[];
  bestMove?: string;
}

const sans = (moves: readonly { san: string }[]): string[] => moves.map((m) => m.san);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** FEN at the tip of the game (the drill keeps the game store's moves equal to `line`). */
function tipFen(): string {
  const g = useGameStore.getState();
  return currentFen({ startFen: g.startFen, moves: g.moves, ply: g.moves.length });
}

function requireBook(): Book {
  const b = hooks.book();
  if (!b) throw new Error('The opening table is not loaded');
  return b;
}

// ---------------------------------------------------------------------------------------------
// Engine

function getLease(): Promise<SearchEngineLease> {
  lease ??= hooks.createEngine().then(
    (l) => {
      useDrillStore.setState({ runsOn: l.runsOn, engineNotice: drillNotice(l.notice) });
      return l;
    },
    (err: unknown) => {
      lease = null;
      throw err;
    },
  );
  return lease;
}

const drillNotice = (n: string | undefined): string | undefined =>
  n?.replace('reviewing in the browser', 'checking in the browser');

async function releaseEngine(): Promise<void> {
  const l = lease;
  lease = null;
  if (!l) return;
  try {
    await (await l).dispose();
  } catch {
    // The lease never opened.
  }
}

/** One search; the last multipv-1 info and the best move. */
async function searchOnce(engine: Engine, fen: string): Promise<SearchResult> {
  const handle = engine.analyze(fen, hooks.search) as AsyncIterable<EngineInfo> & {
    readonly bestMove?: Promise<BestMove | null>;
  };
  let last: EngineInfo | undefined;
  let pv: readonly string[] = [];
  for await (const info of handle) {
    if ((info.multipv ?? 1) !== 1) continue;
    last = info;
    // The final info of a search often carries a truncated line: keep the longer one of the same move.
    if (info.pv.length >= pv.length || info.pv[0] !== pv[0]) pv = info.pv;
  }
  if (!last) throw new Error('The engine returned no evaluation');
  const best = handle.bestMove ? await handle.bestMove : null;
  const bestMove = best?.move ?? pv[0];
  if (bestMove && pv[0] !== bestMove) pv = [bestMove];
  return { score: last.score, pv: [...pv], ...(bestMove ? { bestMove } : {}) };
}

/** The shared browser engine is busy (a review runs) or free again (ADR-015). */
function onEngineWait(waiting: boolean): void {
  if (waiting) {
    deadline?.pause();
    noticeBeforeWait = useDrillStore.getState().engineNotice;
    useDrillStore.setState({ engineNotice: WAITING_NOTICE });
  } else {
    useDrillStore.setState({ engineNotice: noticeBeforeWait });
    noticeBeforeWait = undefined;
    deadline?.resume();
  }
}

const browserDisabled = (): boolean => wasmHealth().disabled !== undefined;

/**
 * Search with fallback: a failing server lease is replaced by the browser engine once; a browser
 * engine that ran out of memory is recreated once (degraded, by the pool); a browser engine that
 * is disabled for the session hands over to the server once (if configured and allowed).
 */
async function search(fen: string): Promise<SearchResult> {
  const hit = evalCache.get(fen);
  if (hit) return hit;
  const l = await getLease();
  let result: SearchResult;
  try {
    result = await searchOnce(l.engine, fen);
  } catch (err) {
    if (l.runsOn.kind !== 'server') {
      if (isRetryableEngineError(err)) {
        result = await searchOnce(l.engine, fen);
      } else if (browserDisabled() && !serverTried && hooks.canUseServer()) {
        serverTried = true;
        void l.dispose().catch(() => undefined);
        lease = hooks.createEngine('server').then((s) => {
          useDrillStore.setState({ runsOn: s.runsOn, engineNotice: drillNotice(s.notice) });
          return s;
        });
        result = await searchOnce((await lease).engine, fen);
      } else {
        throw err;
      }
      evalCache.set(fen, result);
      return result;
    }
    const notice = drillNotice(hooks.reportServerFailure(err));
    void l.dispose().catch(() => undefined);
    lease = hooks.createEngine('browser').then((b) => {
      useDrillStore.setState({ runsOn: b.runsOn, engineNotice: notice });
      return b;
    });
    const b = await lease;
    result = await searchOnce(b.engine, fen);
  }
  evalCache.set(fen, result);
  return result;
}

/** Rejects after `ms` of running time; the clock stops while waiting for the shared engine. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let left = ms;
  let since = 0;
  let fail: (err: Error) => void = () => undefined;
  const t = new Promise<never>((_, reject) => {
    fail = reject;
  });
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
  deadline = own;
  arm();
  return Promise.race([p, t]).finally(() => {
    clearTimeout(timer);
    timer = undefined;
    if (deadline === own) deadline = null;
  });
}

// ---------------------------------------------------------------------------------------------
// Live analysis: off while drilling (no best-move arrow while training), restored afterwards.

function suspendAnalysis(): void {
  const a = useAnalysisStore.getState();
  if (a.enabled) {
    a.setEnabled(false);
    analysisSuspended = true;
  }
  unwatchAnalysis ??= useAnalysisStore.subscribe((s) => {
    if (s.enabled && useDrillStore.getState().status === 'running') {
      analysisSuspended = true;
      s.setEnabled(false);
    }
  });
}

function restoreAnalysis(): void {
  unwatchAnalysis?.();
  unwatchAnalysis = null;
  if (!analysisSuspended) return;
  analysisSuspended = false;
  if (!useAnalysisStore.getState().enabled) useAnalysisStore.getState().setEnabled(true);
}

// ---------------------------------------------------------------------------------------------
// Flow

function cancelPending(): void {
  gen++;
  if (appTimer !== null) clearTimeout(appTimer);
  appTimer = null;
}

/** Ends the drill's watchers and engine; keeps the board. */
function teardown(): void {
  cancelPending();
  unwatchGame?.();
  unwatchGame = null;
  unwatchLocks?.();
  unwatchLocks = null;
  void releaseEngine();
  restoreAnalysis();
}

/** Applies a game-store change made by the drill itself. */
function apply(fn: () => void): void {
  applying = true;
  try {
    fn();
  } finally {
    applying = false;
  }
}

/** Book continuations of the drill (forced along the variation's line until its end). */
function nextMoves(line: readonly string[]) {
  const s = useDrillStore.getState();
  if (!s.opening) return [];
  return requireBook().subtreeMoves(s.opening, line);
}

/** Decides what happens at the tip: line end, app move or the user's turn. */
function advance(): void {
  const s = useDrillStore.getState();
  if (s.status !== 'running') return;
  const moves = nextMoves(s.line);
  if (moves.length === 0) {
    finish('end');
    return;
  }
  if (sideToMove(tipFen()) === s.userColor) {
    useDrillStore.setState({ phase: 'user' });
    return;
  }
  useDrillStore.setState({ phase: 'app' });
  const my = ++gen;
  appTimer = setTimeout(
    () => {
      appTimer = null;
      if (my !== gen) return;
      playAppMove();
    },
    Math.max(0, hooks.appDelayMs()),
  );
}

function playAppMove(): void {
  const s = useDrillStore.getState();
  if (s.status !== 'running' || s.phase !== 'app') return;
  const pick = pickWeighted(nextMoves(s.line), hooks.random);
  const move = pick && resolveSan(tipFen(), pick.san);
  if (!pick || !move) {
    finish('end');
    return;
  }
  apply(() => {
    useGameStore.getState().makeMove(move.from, move.to, move.promotion);
  });
  const line = [...s.line, move.san];
  const name = requireBook().openingAt(line)?.name;
  useDrillStore.setState({
    line,
    current: name ?? s.current,
    feedback: { kind: 'app', san: move.san, ...(name ? { name } : {}) },
  });
  advance();
}

/** The user played `san` at the tip (the game store holds `line` + this move). */
function judge(san: string): void {
  const s = useDrillStore.getState();
  const book = requireBook();
  const ply = s.line.length;
  const line = [...s.line, san];
  const allowed = nextMoves(s.line);
  if (allowed.some((m) => m.san === san)) {
    const name = book.openingAt(line)?.name;
    const first = !failedPlies.has(ply);
    useDrillStore.setState({
      line,
      current: name ?? s.current,
      userMoves: s.userMoves + 1,
      firstTry: s.firstTry + (first ? 1 : 0),
      feedback: { kind: 'book', san, ...(name ? { name } : {}) },
    });
    advance();
    return;
  }
  const onTheWay = s.opening !== undefined && ply < s.opening.moves.length;
  const expected = onTheWay ? s.opening!.moves[ply] : undefined;
  if (onTheWay && book.inBook(line)) {
    // Book, but another variation than the drilled one: try the line's move (not a mistake).
    const name = book.openingAt(line)?.name;
    useDrillStore.setState({
      phase: 'retry',
      feedback: { kind: 'otherLine', san, expected: expected!, ...(name ? { name } : {}) },
    });
    return;
  }
  void check(san, onTheWay, expected);
}

/** Engine check of a deviation from the book. */
async function check(san: string, onTheWay: boolean, expected: string | undefined): Promise<void> {
  const s = useDrillStore.getState();
  const my = ++gen;
  const ply = s.line.length;
  const g = useGameStore.getState();
  const fenBefore = ply === 0 ? g.startFen : g.moves[ply - 1]!.fen;
  const played = g.moves[ply]!;
  const playedUci = `${played.from}${played.to}${played.promotion ?? ''}`;
  useDrillStore.setState({ phase: 'checking', feedback: { kind: 'checking', san } });
  try {
    const { best, playedScore } = await withTimeout(
      (async () => {
        const best = await search(fenBefore);
        const terminal = terminalScore(played.fen);
        const playedScore =
          terminal ?? (best.bestMove === playedUci ? best.score : (await search(played.fen)).score);
        return { best, playedScore };
      })(),
      hooks.checkTimeoutMs,
    );
    if (my !== gen || useDrillStore.getState().status !== 'running') return;
    const verdict = judgeDeviation(best.score, playedScore, s.userColor);
    if (verdict.fine) {
      const st = useDrillStore.getState();
      if (onTheWay) {
        useDrillStore.setState({
          phase: 'retry',
          feedback: {
            kind: 'fine',
            san,
            eval: formatEval(playedScore),
            retry: true,
            ...(expected ? { expected } : {}),
          },
        });
        return;
      }
      const first = !failedPlies.has(ply);
      useDrillStore.setState({
        line: [...st.line, san],
        userMoves: st.userMoves + 1,
        firstTry: st.firstTry + (first ? 1 : 0),
        feedback: { kind: 'fine', san, eval: formatEval(playedScore), retry: false },
      });
      finish('outOfBook');
      return;
    }
    failedPlies.add(ply);
    const pv = best.pv.slice(0, PV_MOVES);
    const converted = convertPv(fenBefore, pv);
    const bestSan = best.bestMove ? convertPv(fenBefore, [best.bestMove]).san[0] : undefined;
    useDrillStore.setState({
      phase: 'retry',
      mistakes: useDrillStore.getState().mistakes + 1,
      feedback: {
        kind: 'mistake',
        san,
        playedUci,
        playedEval: formatEval(playedScore),
        bestEval: formatEval(best.score),
        lossCp: verdict.lossCp,
        ...(bestSan ? { bestSan } : {}),
        ...(best.bestMove ? { bestUci: best.bestMove } : {}),
        pvSan: converted.san,
        pvText: converted.text,
        pvUci: pv.slice(0, converted.count),
      },
    });
  } catch (err) {
    if (my !== gen || useDrillStore.getState().status !== 'running') return;
    if (browserDisabled() && useDrillStore.getState().runsOn?.kind !== 'server') {
      // Out of memory twice (ADR-015): say it once and end, instead of an error on every move.
      endWithMessage(`Drill ended: the browser engine is unavailable (${message(err)}).`);
      return;
    }
    // A broken engine is not reused; the next check opens a new one.
    void releaseEngine();
    useDrillStore.setState({
      phase: 'retry',
      feedback: { kind: 'error', san, message: message(err) },
    });
  }
}

function finish(reason: DrillEndReason): void {
  const s = useDrillStore.getState();
  teardown();
  const summary: DrillSummary = {
    reason,
    userMoves: s.userMoves,
    firstTry: s.firstTry,
    mistakes: s.mistakes,
    ...(s.current ? { reached: s.current } : {}),
  };
  let schedule = s.schedule;
  // Only a drill with at least one move of the user counts for the schedule.
  if (s.opening && s.userMoves > 0) {
    schedule = recordResult(
      schedule,
      openingKey(s.opening),
      s.mistakes === 0,
      hooks.now(),
      s.mistakes,
    );
    saveSchedule(hooks.storage, schedule);
  }
  useDrillStore.setState({ status: 'done', phase: 'none', summary, schedule });
  if (s.afterBook !== 'stop') {
    // Continue against the chosen opponent (outside the game store's notification).
    clearContinue();
    continueTimer = setTimeout(() => {
      continueTimer = null;
      if (get().status === 'done' && get().summary === summary) get().playOn();
    }, 0);
  }
}

/** Reacts to game store changes while a drill runs (the user's moves, takebacks, loads). */
function onGameChange(
  g: ReturnType<typeof useGameStore.getState>,
  prev: ReturnType<typeof useGameStore.getState>,
): void {
  if (applying) return;
  const s = useDrillStore.getState();
  if (s.status !== 'running') return;
  if (g.headers !== prev.headers || g.startFen !== prev.startFen) {
    endWithMessage('Drill ended: another position was loaded.');
    return;
  }
  if (g.moves === prev.moves) return;
  const moves = sans(g.moves);
  const line = s.line;
  const isPrefix = moves.length <= line.length && moves.every((m, i) => m === line[i]);
  if (isPrefix) {
    // Takeback (Undo): continue from there.
    cancelPending();
    useDrillStore.setState({ line: moves, feedback: undefined });
    advance();
    return;
  }
  const appended =
    moves.length === line.length + 1 && line.every((m, i) => m === moves[i]) && s.phase === 'user';
  if (appended) {
    judge(moves[moves.length - 1]!);
    return;
  }
  if (
    s.phase === 'retry' &&
    moves.length === line.length + 1 &&
    line.every((m, i) => m === moves[i])
  ) {
    return; // unchanged rejected move (e.g. a re-render of the same moves array)
  }
  endWithMessage('Drill ended: the game was changed.');
}

function endWithMessage(text: string): void {
  teardown();
  useDrillStore.setState({ status: 'idle', phase: 'none', message: text });
}

function watch(): void {
  unwatchGame?.();
  unwatchGame = useGameStore.subscribe(onGameChange);
  unwatchLocks?.();
  // Starting a live, room or engine game ends the drill (fair play: the drill uses an engine).
  const onLock = () => {
    if (useDrillStore.getState().status !== 'running') return;
    const lock = humanGameLockReason();
    if (lock) endWithMessage(`Drill ended: ${lockText(lock) ?? 'a game started'}.`);
  };
  const a = usePlayStore.subscribe(onLock);
  const b = useLiveStore.subscribe(onLock);
  const c = useRoomStore.subscribe(onLock);
  unwatchLocks = () => {
    a();
    b();
    c();
  };
}

function nextOpening(o: BookOpening): BookOpening | undefined {
  const all = requireBook().openings;
  return all[(o.id + 1) % all.length];
}

const set = useDrillStore.setState;
const get = useDrillStore.getState;

/** The drill's actions; installed into {@link useDrillStore} when this module loads. */
const actions: DrillActions = {
  start: (opening, color) => {
    clearContinue();
    const lock = humanGameLockReason();
    if (lock) {
      set({ message: `The drill uses the engine: ${lockText(lock) ?? 'a game runs'}.` });
      return;
    }
    teardown();
    failedPlies = new Set();
    evalCache.clear();
    serverTried = false;
    const colorChoice = color ?? get().colorChoice;
    const userColor: Orientation =
      colorChoice === 'both' ? (runs % 2 === 0 ? 'white' : 'black') : colorChoice;
    runs++;
    apply(() => {
      useGameStore.getState().reset();
      useGameStore.setState({ orientation: userColor });
    });
    suspendAnalysis();
    watch();
    set({
      status: 'running',
      phase: 'none',
      opening,
      colorChoice,
      userColor,
      line: [],
      current: undefined,
      userMoves: 0,
      firstTry: 0,
      mistakes: 0,
      summary: undefined,
      message: undefined,
      runsOn: undefined,
      engineNotice: undefined,
      feedback: {
        kind: 'start',
        text: `You play ${userColor === 'white' ? 'White' : 'Black'}: ${opening.name}.`,
      },
    });
    advance();
  },

  setColorChoice: (colorChoice) => set({ colorChoice }),

  setAfterBook: (after) => {
    const afterBook = sanitizeAfterBook(after);
    set({ afterBook });
    try {
      hooks.storage?.setItem(AFTER_BOOK_KEY, afterBook);
    } catch {
      // Storage full or blocked: the choice is just not remembered.
    }
  },

  retry: () => {
    const s = get();
    if (s.status !== 'running' || s.phase !== 'retry') return;
    cancelPending();
    const san = s.feedback && 'san' in s.feedback ? s.feedback.san : '';
    const n = s.line.length;
    apply(() => {
      const g = useGameStore.getState();
      useGameStore.setState({ moves: g.moves.slice(0, n), ply: n });
    });
    set({ phase: 'user', feedback: { kind: 'retry', san } });
  },

  stop: (text) => {
    if (get().status === 'idle') return;
    teardown();
    set({ status: 'idle', phase: 'none', message: text, feedback: undefined, summary: undefined });
  },

  repeat: () => {
    const o = get().opening;
    if (o) get().start(o);
  },

  next: () => {
    const o = get().opening;
    const n = o && hooks.book() ? nextOpening(o) : undefined;
    if (n) get().start(n);
  },

  trainDue: () => {
    const book = hooks.book();
    if (!book) return false;
    for (const key of dueKeys(get().schedule, hooks.now())) {
      const o = book.find(key);
      if (o) {
        get().start(o);
        return true;
      }
    }
    return false;
  },

  playOn: () => {
    // M18-3: the engine game starts at once from the drill's position (the moves so far stay in
    // the game, so the review covers the opening too), with the user's drill colour.
    // The opponent is the "after the book" choice (M23-2; `stop`: the Play tab's last setup).
    clearContinue();
    const color = get().userColor;
    const strength = afterBookStrength(get().afterBook);
    if (get().status === 'running') get().stop();
    const play = usePlayStore.getState();
    play.start({ from: 'current', color, ...(strength ? { strength } : {}) });
    const after = usePlayStore.getState();
    if (after.mode !== 'playing') {
      // A live/room game runs, Maia is unavailable or the position is over: say why (the
      // summary stays).
      set({ message: after.message ?? 'The game against the engine could not start.' });
      return;
    }
    get().stop();
    useUiStore.getState().setActiveTab('play');
  },
};

useDrillStore.setState({
  ...actions,
  schedule: loadSchedule(DEFAULT_HOOKS.storage),
  afterBook: loadAfterBook(DEFAULT_HOOKS.storage),
});

/** Number of due variations (badge of the picker). */
export function dueCount(schedule: Schedule, now: number): number {
  return dueKeys(schedule, now).length;
}

/** Test seam: replaces hooks (engine, delay, random, clock, storage, book) and resets the drill. */
export async function configureDrill(next: Partial<DrillHooks>): Promise<void> {
  await resetDrill();
  hooks = { ...hooks, ...next };
  useDrillStore.setState({
    schedule: loadSchedule(hooks.storage),
    afterBook: loadAfterBook(hooks.storage),
  });
}

/** Ends any drill, releases the engine and restores the default hooks' state (tests). */
export async function resetDrill(): Promise<void> {
  cancelPending();
  clearContinue();
  unwatchGame?.();
  unwatchGame = null;
  unwatchLocks?.();
  unwatchLocks = null;
  await releaseEngine();
  restoreAnalysis();
  failedPlies = new Set();
  evalCache.clear();
  runs = 0;
  serverTried = false;
  deadline = null;
  noticeBeforeWait = undefined;
  hooks = DEFAULT_HOOKS;
  useDrillStore.setState({
    status: 'idle',
    phase: 'none',
    opening: undefined,
    colorChoice: 'white',
    userColor: 'white',
    line: [],
    feedback: undefined,
    current: undefined,
    userMoves: 0,
    firstTry: 0,
    mistakes: 0,
    summary: undefined,
    message: undefined,
    runsOn: undefined,
    engineNotice: undefined,
    afterBook: 'stop',
  });
}
