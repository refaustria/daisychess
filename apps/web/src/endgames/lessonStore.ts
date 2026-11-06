import {
  fenAfter,
  initialLesson,
  lessonState,
  opponentMove as packageOpponentMove,
  type Lesson,
  type LessonEvent,
  type LessonGroup,
  type LessonState,
  type OpponentPolicy,
  type TablebaseProbe,
  type TbPosition,
} from '@daisychess/endgames';
import { pauseAnalysis } from '../engine/analysisPause';
import { humanGameLockReason, lockText, type HumanGameLock } from '../live/lock';
import { useLiveStore } from '../live/liveStore';
import { usePlayStore } from '../play/playStore';
import { usePuzzleStore } from '../puzzles/puzzleStore';
import { useRoomStore } from '../room/roomStore';
import { useGameStore, type GameState, type MoveRecord } from '../store/gameStore';
import { useSettingsStore, type TablebaseSetting } from '../store/settingsStore';
import { resolveSan } from '../trainer/drill';
import { useDrillStore } from '../trainer/drillState';
import { LESSONS } from './data/lessons';
import {
  dueLessons,
  loadProgress,
  markDone,
  recordAttempt,
  saveProgress,
} from './endgamesProgress';
import type { LocalCoverage } from './localTablebase';
import {
  useLessonStore,
  type LessonActions,
  type LessonStore,
  type LessonStoreState,
  type ThrownInfo,
} from './lessonSession';
import { registerLessonStop } from './navigate';
import { formatBytes, packSize, type OptInPack } from './tablePacks';
import {
  isAbortError,
  localCoverage,
  opponentPolicyFor,
  resolveTablebase,
  tablebaseProbe,
  type ProbeOptions,
  type TbAnswer,
  type TbResolution,
} from './tablebaseStore';

export * from './lessonSession';

/*
 * Endgame lesson session (ADR-025 §6): drives the game store (position, the opponent's moves,
 * orientation) and the board (`movableColor` via `components/Endgames/useEndgameBoard.ts`)
 * around the pure reducer `lessonState` of `@daisychess/endgames`. The tablebase comes from
 * `tablebaseStore` (cache → local tables → lichess, per the setting); the opponent is
 * `opponentMove` with the policy of the answer's source (`dtz`, or `wdlTrappy` for WDL-only
 * local tables).
 *
 * Invariant while a session runs: the game store holds `startFen = lesson.fen` and the moves of
 * `game.played` (plus, while it is being judged, the user's new move). Any other change of the
 * game store ends the session.
 */

/** The opponent replies after this pause (ADR-025 §6). */
export const REPLY_DELAY_MS = 300;

export const OFF_TEXT =
  'Endgame lessons need the tablebase, which is switched off in Settings → Endgames.';

export const packText = (pack: OptInPack): string =>
  `Needs the rook endgames download (${formatBytes(packSize(pack))}) to play offline.`;

// ---------------------------------------------------------------------------------------------
// Dependencies (tests replace some of them)

export interface LessonDeps {
  lessons: readonly Lesson[];
  resolve: (fen: string, opts?: ProbeOptions) => Promise<TbResolution>;
  /** Child probes of the `wdlTrappy` policy. */
  probe: TablebaseProbe;
  coverage: (fen: string) => Promise<LocalCoverage>;
  opponentMove: (pos: TbPosition, probe: TablebaseProbe, policy: OpponentPolicy) => Promise<string>;
  setting: () => TablebaseSetting;
  lock: () => HumanGameLock;
  now: () => number;
  replyDelayMs: number;
}

const defaultDeps = (): LessonDeps => ({
  lessons: LESSONS,
  resolve: resolveTablebase,
  probe: tablebaseProbe,
  coverage: localCoverage,
  opponentMove: packageOpponentMove,
  setting: () => useSettingsStore.getState().tablebase,
  lock: humanGameLockReason,
  now: Date.now,
  replyDelayMs: REPLY_DELAY_MS,
});

let deps: LessonDeps = defaultDeps();

// ---------------------------------------------------------------------------------------------
// Session internals

/** Bumped whenever pending async work (timers, probes) becomes stale. */
let gen = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let sessionCtl: AbortController | null = null;
let unwatchGame: (() => void) | null = null;
let unwatchLocks: (() => void) | null = null;
let releaseAnalysis: (() => void) | null = null;
/** True while the store itself changes the game store (its own subscriber ignores that). */
let applying = false;
/** Tablebase answers of this session by FEN (positions repeat after take-backs). */
const answers = new Map<string, TbAnswer>();
/** The attempt whose result was recorded already, and the mistake count at its start. */
let recordedAttempt: number | null = null;
let attemptBase = 0;

const set = (partial: Partial<LessonStoreState>): void => useLessonStore.setState(partial);
const get = (): LessonStore => useLessonStore.getState();

const isSession = (): boolean => {
  const st = get().status;
  return st === 'running' || st === 'done' || st === 'starting';
};

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function cancelPending(): void {
  gen++;
  clearTimer();
  if (get().thinking) set({ thinking: false });
}

/** Stops watchers, timers, running probes and (unless kept) the analysis pause. */
function teardown(keepAnalysis = false): void {
  cancelPending();
  sessionCtl?.abort();
  sessionCtl = null;
  unwatchGame?.();
  unwatchGame = null;
  unwatchLocks?.();
  unwatchLocks = null;
  if (!keepAnalysis) {
    releaseAnalysis?.();
    releaseAnalysis = null;
  }
}

function apply(fn: () => void): void {
  applying = true;
  try {
    fn();
  } finally {
    applying = false;
  }
}

const moveUci = (m: Pick<MoveRecord, 'from' | 'to' | 'promotion'>): string =>
  `${m.from}${m.to}${m.promotion ?? ''}`;

/** Plays `uci` at the tip of the game store (jumps there first: the user may have stepped back). */
function playOnBoard(uci: string): boolean {
  let ok = false;
  apply(() => {
    const g = useGameStore.getState();
    if (g.ply !== g.moves.length) g.goTo(g.moves.length);
    ok = useGameStore
      .getState()
      .makeMove(uci.slice(0, 2), uci.slice(2, 4), uci.length > 4 ? uci[4] : undefined);
  });
  return ok;
}

/** Cuts the game store back to `n` moves (take-back, restart, a refused move). */
function truncateBoard(n: number): void {
  apply(() => {
    const g = useGameStore.getState();
    if (g.moves.length > n) useGameStore.setState({ moves: g.moves.slice(0, n), ply: n });
    else if (g.ply !== g.moves.length) g.goTo(g.moves.length);
  });
}

/** Ends the session and keeps the lesson on the panel with `text` (and the pack offer). */
function endWithMessage(text: string, needsPack?: OptInPack): void {
  teardown();
  set({
    status: 'idle',
    thinking: false,
    message: text,
    ...(needsPack ? { needsPack } : {}),
  });
}

/** Message for a tablebase miss during a lesson. */
function missText(r: Extract<TbResolution, { ok: false }>): string {
  switch (r.reason) {
    case 'off':
      return OFF_TEXT;
    case 'locked':
      return `Lesson ended: ${lockText(humanGameLockReason()) ?? 'a game started'}.`;
    case 'needs-download':
      return `The lichess tablebase did not answer. ${packText(r.pack ?? 'rook')}`;
    default:
      return 'Lesson ended: the tablebase did not answer (offline or busy). Try again later.';
  }
}

/** The tablebase answer for `fen` in this session (one retry after a foreign abort). */
async function answerFor(fen: string): Promise<TbResolution> {
  const known = answers.get(fen);
  if (known) return { ok: true, answer: known };
  const signal = sessionCtl?.signal;
  for (let tries = 0; ; tries++) {
    try {
      const r = await deps.resolve(fen, signal ? { signal } : {});
      if (r.ok) {
        answers.set(fen, r.answer);
        if (get().source !== r.answer.source) set({ source: r.answer.source });
      }
      return r;
    } catch (e) {
      // Our own teardown: the caller sees a stale generation. Another abort (cancelAll): retry.
      if (!isAbortError(e) || signal?.aborted || tries >= 1) {
        return { ok: false, reason: 'unavailable' };
      }
    }
  }
}

/** The lesson `id` of the course (undefined for an unknown id). */
export function lessonById(id: string | undefined): Lesson | undefined {
  return id === undefined ? undefined : deps.lessons.find((l) => l.id === id);
}

/** Records the result once per attempt; a later success of the same attempt only marks done. */
function settle(s: LessonState): void {
  if (s.phase !== 'done' || !s.outcome) return;
  const id = s.lesson.id;
  const now = deps.now();
  const success = s.outcome === 'success';
  let progress = get().progress;
  if (recordedAttempt === s.attempts) {
    if (!success) return;
    progress = markDone(progress, id, now);
  } else {
    recordedAttempt = s.attempts;
    const mistakes = s.hints + s.mistakes - attemptBase;
    progress = recordAttempt(progress, id, { success, mistakes, now });
  }
  if (progress === get().progress) return;
  set({ progress });
  saveProgress(progress);
}

/** Applies a reducer event and follows up (timers, settlement). */
function dispatch(event: LessonEvent): LessonState | undefined {
  const st = get();
  if (!st.game || (st.status !== 'running' && st.status !== 'done')) return undefined;
  const next = lessonState(st.game, event);
  if (next === st.game) return next;
  set({ game: next });
  followUp(next);
  return next;
}

function schedule(ms: number, fn: () => void): void {
  clearTimer();
  const my = gen;
  timer = setTimeout(() => {
    timer = null;
    if (my !== gen) return;
    fn();
  }, ms);
}

function followUp(s: LessonState): void {
  switch (s.phase) {
    case 'app':
      set({ thinking: true });
      schedule(deps.replyDelayMs, () => void opponentTurn());
      return;
    case 'user':
      set({ status: 'running', thinking: false });
      // Prefetch: the user's move is judged against this position.
      void answerFor(s.fen);
      return;
    case 'done':
      clearTimer();
      set({ status: 'done', thinking: false });
      settle(s);
      return;
    case 'intro':
      return;
  }
}

/** The opponent's reply: the tablebase position, the policy's move, then the position after it. */
async function opponentTurn(): Promise<void> {
  const my = gen;
  const s = get().game;
  if (!s || s.phase !== 'app' || get().status !== 'running') return;
  const r = await answerFor(s.fen);
  if (my !== gen) return;
  if (!r.ok) {
    endWithMessage(missText(r), r.reason === 'needs-download' ? (r.pack ?? 'rook') : undefined);
    return;
  }
  let uci: string;
  try {
    uci = await deps.opponentMove(r.answer.pos, deps.probe, opponentPolicyFor(r.answer));
  } catch {
    if (my !== gen) return;
    endWithMessage(
      'Lesson ended: the tablebase did not answer (offline or busy). Try again later.',
    );
    return;
  }
  if (my !== gen) return;
  const after = fenAfter(s.fen, uci);
  if (after === undefined || !playOnBoard(uci)) {
    endWithMessage('Lesson ended: the opponent’s move is not legal in this position.');
    return;
  }
  const next = await answerFor(after);
  if (my !== gen) return;
  dispatch({ type: 'reply', uci, tb: next.ok ? next.answer.pos : null });
}

/** The user's move on the board (`uci`), judged against the position before it. */
async function userMove(uci: string, before: LessonState): Promise<void> {
  const my = gen;
  set({ thinking: true, inputError: undefined });
  const r = await answerFor(before.fen);
  if (my !== gen) return;
  if (!r.ok) {
    truncateBoard(before.played.length);
    endWithMessage(missText(r), r.reason === 'needs-download' ? (r.pack ?? 'rook') : undefined);
    return;
  }
  const pos = r.answer.pos;
  const after = dispatch({ type: 'move', uci, tb: pos });
  if (!after || after === before) {
    // Not accepted by the reducer: take it back.
    truncateBoard(before.played.length);
    set({ thinking: false });
    return;
  }
  if (after.reason === 'thrown' && after.verdict) {
    const v = after.verdict;
    const keeperUci = v.keepers[0];
    const keeperSan = pos.moves.find((m) => m.uci === keeperUci)?.san;
    set({
      thrown: {
        uci: v.uci,
        san: v.san,
        ...(keeperUci ? { keeperUci } : {}),
        ...(keeperSan ? { keeperSan } : {}),
      },
    });
  }
}

/** Game store changes while a session runs: the user's moves, navigation, loads. */
function onGameChange(g: GameState, prev: GameState): void {
  if (applying) return;
  const st = get();
  if (st.status !== 'running' && st.status !== 'done') return;
  if (g.headers !== prev.headers || g.startFen !== prev.startFen) {
    endWithMessage('Lesson ended: another position was loaded.');
    return;
  }
  if (g.moves === prev.moves) return; // navigation
  const s = st.game;
  if (!s) return;
  if (st.status === 'done') {
    // Exploring after the end: the session is over, the result stays on the panel.
    teardown();
    set({ status: 'idle', thinking: false });
    return;
  }
  const n = s.played.length;
  if (s.phase === 'user' && !st.thinking && g.moves.length === n + 1 && prev.moves.length === n) {
    void userMove(moveUci(g.moves[n]!), s);
    return;
  }
  endWithMessage('Lesson ended: the board was changed.');
}

function watch(): void {
  unwatchGame?.();
  unwatchGame = useGameStore.subscribe(onGameChange);
  unwatchLocks?.();
  const onLock = () => {
    if (!isSession()) return;
    const lock = deps.lock();
    if (lock) endWithMessage(`Lesson ended: ${lockText(lock) ?? 'a game started'}.`);
  };
  const offs = [
    usePlayStore.subscribe(onLock),
    useLiveStore.subscribe(onLock),
    useRoomStore.subscribe(onLock),
  ];
  unwatchLocks = () => offs.forEach((off) => off());
}

/** The tablebase answer for the current position (hint, show move), or null. */
async function currentPos(): Promise<TbPosition | null> {
  const s = get().game;
  if (!s) return null;
  const r = await answerFor(s.fen);
  return r.ok ? r.answer.pos : null;
}

const actions: LessonActions = {
  start: async (id) => {
    const lesson = lessonById(id);
    if (!lesson) {
      set({ message: 'This lesson does not exist.' });
      return false;
    }
    const lock = deps.lock();
    if (lock) {
      set({ message: `Lessons are paused: ${lockText(lock) ?? 'a game runs'}.` });
      return false;
    }
    // Other trainers end first (they would read the new position as "another position loaded").
    usePuzzleStore.getState().stop();
    useDrillStore.getState().stop();
    teardown(true);
    const my = gen;
    answers.clear();
    sessionCtl = new AbortController();
    set({
      status: 'starting',
      lessonId: lesson.id,
      game: undefined,
      source: undefined,
      thinking: false,
      thrown: undefined,
      message: undefined,
      needsPack: undefined,
      inputError: undefined,
    });
    releaseAnalysis ??= pauseAnalysis(isSession);
    const setting = deps.setting();
    if (setting === 'off') {
      teardown();
      set({ status: 'idle', message: OFF_TEXT });
      return false;
    }
    let cov: LocalCoverage;
    try {
      cov = await deps.coverage(lesson.fen);
    } catch {
      cov = { wdl: false, dtz: false, missing: [] };
    }
    if (my !== gen) return false;
    if (!cov.wdl && setting !== 'online') {
      teardown();
      set({ status: 'idle', message: packText('rook'), needsPack: 'rook' });
      return false;
    }
    let loaded = false;
    apply(() => {
      loaded = useGameStore.getState().loadFen(lesson.fen);
      if (loaded) useGameStore.setState({ orientation: lesson.userSide });
    });
    if (!loaded) {
      teardown();
      set({ status: 'idle', message: 'This lesson has an invalid position.' });
      return false;
    }
    watch();
    const game = lessonState(initialLesson(lesson), { type: 'start' });
    recordedAttempt = null;
    attemptBase = 0;
    set({ status: 'running', game, source: cov.wdl ? 'local' : 'lichess' });
    followUp(game);
    return true;
  },

  playSan: (san) => {
    const st = get();
    const s = st.game;
    const text = san.trim();
    if (st.status !== 'running' || !s || s.phase !== 'user' || st.thinking || !text) {
      set({ inputError: 'Wait for your turn.' });
      return false;
    }
    const move = resolveSan(s.fen, text);
    if (!move) {
      set({ inputError: `${text} is not a legal move here.` });
      return false;
    }
    set({ inputError: undefined });
    const g = useGameStore.getState();
    if (g.ply !== g.moves.length) apply(() => g.goTo(g.moves.length));
    // Through the game store like a board move (sound, haptics and the watcher's judgement).
    return useGameStore.getState().makeMove(move.from, move.to, move.promotion);
  },

  hint: async () => {
    const st = get();
    if (st.status !== 'running' || st.game?.phase !== 'user' || st.thinking) return;
    const my = gen;
    const tb = await currentPos();
    if (my !== gen) return;
    dispatch({ type: 'hint', tb });
  },

  showMove: async () => {
    const st = get();
    if (st.status !== 'running' || st.game?.phase !== 'user' || st.thinking) return;
    const my = gen;
    const tb = await currentPos();
    if (my !== gen) return;
    if (!tb) {
      set({ message: 'The tablebase did not answer; no move to show.' });
      return;
    }
    dispatch({ type: 'showMove', tb });
  },

  takeBack: () => {
    const st = get();
    const s = st.game;
    if (!s || (st.status !== 'running' && st.status !== 'done') || st.thinking) return;
    const next = lessonState(s, { type: 'takeBack' });
    if (next === s) return;
    cancelPending();
    truncateBoard(next.played.length);
    set({ game: next, thrown: undefined, message: undefined, inputError: undefined });
    followUp(next);
  },

  restart: () => {
    const st = get();
    const s = st.game;
    if (!s || (st.status !== 'running' && st.status !== 'done')) {
      if (st.lessonId) void get().start(st.lessonId);
      return;
    }
    cancelPending();
    const next = lessonState(s, { type: 'restart' });
    truncateBoard(0);
    attemptBase = next.hints + next.mistakes;
    set({ game: next, thrown: undefined, message: undefined, inputError: undefined });
    followUp(next);
  },

  stop: (message) => {
    const st = get();
    if (st.status === 'idle' && releaseAnalysis === null && st.lessonId === undefined) {
      if (message !== undefined) set({ message });
      return;
    }
    teardown();
    set({
      status: 'idle',
      lessonId: undefined,
      game: undefined,
      thinking: false,
      thrown: undefined,
      needsPack: undefined,
      inputError: undefined,
      message,
    });
  },

  nextLesson: () => {
    const list = deps.lessons;
    const i = list.findIndex((l) => l.id === get().lessonId);
    const next = list[i + 1] ?? list[0];
    return next ? get().start(next.id) : Promise.resolve(false);
  },

  trainDue: () => {
    const due = dueLessons(
      get().progress,
      deps.now(),
      deps.lessons.map((l) => l.id),
    );
    return due[0] ? get().start(due[0]) : Promise.resolve(false);
  },
};

// The flow's actions replace the placeholders of the light store (see `lessonSession.ts`).
useLessonStore.setState(actions);
registerLessonStop(() => get().stop());

// ---------------------------------------------------------------------------------------------
// Selectors

/** The lessons of the course, in order. */
export const courseLessons = (): readonly Lesson[] => deps.lessons;

const RESULT_WORD = { win: 'the win', draw: 'the draw', loss: 'the loss' } as const;

/** "Rh1? throws away the win — the position is a draw now. Rc4 keeps it." */
export function thrownText(s: LessonState, t: ThrownInfo | undefined): string {
  const v = s.verdict;
  const san = t?.san ?? v?.san ?? 'That move';
  const now = v?.after === 'loss' ? 'lost' : 'a draw';
  const keep = t?.keeperSan
    ? ` ${t.keeperSan} ${s.lesson.goal === 'win' ? 'keeps it' : 'holds'}.`
    : '';
  const what = s.lesson.goal === 'win' ? `throws away ${RESULT_WORD.win}` : 'loses';
  return `${san}? ${what} — the position is ${now} now.${keep}`;
}

/** The result sentence of a finished lesson. */
export function resultText(s: LessonState, t?: ThrownInfo): string {
  const win = s.lesson.goal === 'win';
  switch (s.reason) {
    case 'thrown':
      return thrownText(s, t);
    case 'mate':
      return 'Checkmate! Lesson complete.';
    case 'held':
      return `Held for ${s.opponentMoves} moves — the draw is safe. Lesson complete.`;
    case 'tablebaseDraw':
      return 'Only a dead-drawn ending is left — the draw is safe. Lesson complete.';
    case 'budget':
      return `Not converted within ${s.userMoves} moves.`;
    case 'mated':
      return 'Checkmated — the lesson failed.';
    case 'stalemate':
      return win
        ? 'Stalemate — the win slipped away.'
        : 'Stalemate — the draw is safe. Lesson complete.';
    case 'insufficient':
      return win
        ? 'Not enough material left to mate — the win slipped away.'
        : 'Not enough material left to mate — the draw is safe. Lesson complete.';
    case 'fiftyMoves':
      return win
        ? 'Draw by the 50-move rule — the win slipped away.'
        : 'Draw by the 50-move rule. Lesson complete.';
    case 'repetition':
      return win
        ? 'Draw by threefold repetition — the win slipped away.'
        : 'Draw by threefold repetition. Lesson complete.';
    default:
      return '';
  }
}

const sideName = (side: 'white' | 'black'): string => (side === 'white' ? 'White' : 'Black');

/** The status line of the lesson view (read out by screen readers). */
export function lessonStatusLine(
  s: Pick<LessonStoreState, 'status' | 'game' | 'thinking' | 'thrown' | 'message'>,
): string {
  const g = s.game;
  if (s.status === 'starting') return 'Preparing the lesson…';
  if (!g) return s.message ?? 'Choose a lesson.';
  if (g.phase === 'done') return resultText(g, s.thrown);
  if (s.status !== 'running') return s.message ?? 'The lesson was ended.';
  const side = sideName(g.lesson.userSide);
  const v = g.verdict;
  const last = v
    ? v.kind === 'only'
      ? `${v.san} — the only move! `
      : `${v.san} keeps ${RESULT_WORD[v.before]}. `
    : '';
  if (g.phase === 'app' || s.thinking) {
    return s.thinking && g.phase === 'user' ? 'Checking the move…' : `${last}The opponent replies…`;
  }
  if (g.hintSquare) return `Hint: move the highlighted piece (${side} to play).`;
  if (g.shownMove) return `The arrow shows the best move (${side} to play).`;
  return `${last}Your move (${side}).`;
}

/** "12 of 14 moves left" (win) or "Hold for 8 more moves" (draw). */
export function budgetLine(g: LessonState): string {
  if (g.lesson.goal === 'win') {
    const left = Math.max(0, g.lesson.budget - g.userMoves);
    return `Goal: checkmate within ${g.lesson.budget} moves · ${left} left`;
  }
  const left = Math.max(0, g.lesson.budget - g.opponentMoves);
  return `Goal: hold the draw for ${g.lesson.budget} moves · ${left} to go`;
}

/** Course groups in order with their titles. */
export const GROUP_TITLES: Record<LessonGroup, string> = {
  basic_mates: 'Basic mates',
  king_pawn: 'King and pawn',
  queen_pawn: 'Queen against pawn',
  rook_pawn: 'Rook endings',
};

// ---------------------------------------------------------------------------------------------
// Test seams

/** Tests: replace some dependencies (the rest keep their defaults); `null` resets all. */
export function configureLessonStore(patch: Partial<LessonDeps> | null): void {
  deps = patch === null ? defaultDeps() : { ...deps, ...patch };
}

/** Tests: ends any session and forgets the state (progress re-read from storage). */
export function resetLessonStore(): void {
  teardown();
  answers.clear();
  recordedAttempt = null;
  attemptBase = 0;
  useLessonStore.setState({
    status: 'idle',
    lessonId: undefined,
    game: undefined,
    source: undefined,
    thinking: false,
    thrown: undefined,
    message: undefined,
    needsPack: undefined,
    inputError: undefined,
    progress: loadProgress(),
  });
}
