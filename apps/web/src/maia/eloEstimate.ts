/**
 * Elo estimate per player of a reviewed game (ADR-024 §5): "played like ~1540 here".
 *
 * Two sources, one display:
 * - **Maia maximum likelihood** (server): for the scored positions of a side (`selectEloPlies`)
 *   the probability each of the nine Maia levels gives the played move, queried through the hint
 *   runner (`runHintJobs`, `policyMoves: [played, best]`, level-major so the server's three-process
 *   Maia cap swaps one process per level), cached per `(gameKey, ply, rating)` in the hint cache
 *   (a partial run resumes on the next visit), turned into an estimate with engine-core's
 *   `eloLikelihood` and written once into the review record (`review/eloRecord.ts`).
 * - **Offline fallback**: the side's mean win-probability loss over the same positions through
 *   the committed calibration table (`review/data/eloCalibration.json`); computed at once, never
 *   stored, always labelled approximate.
 *
 * The Maia estimate is preferred for a side whenever it exists. Nothing is shown for a side with
 * fewer than `ELO_MIN_POSITIONS` scored positions or for the engine's side of a Play-tab game.
 */
import {
  EloCalibrationSchema,
  MAIA_ELO_LEVELS,
  MAIA_ELO_VERSION,
  eloLikelihood,
  fallbackElo,
  reviewGameKey,
  selectEloPlies,
  speedClass,
  type EloCalibration,
  type EloEstimate,
  type EloSample,
  type MaiaEloLevel,
  type ReviewSummary,
  type SpeedClass,
} from '@daisychess/engine-core';
import { Chess } from 'chess.js';
import { create } from 'zustand';
import calibrationJson from '../review/data/eloCalibration.json';
import { writeEloRecord } from '../review/eloRecord';
import type { StoredElo } from '../review/reviewCache';
import { useGameStore } from '../store/gameStore';
import type { ReviewEnginePreference } from '../store/settingsStore';
import { hintTiming } from './hintClient';
import { getStoredHints, hintId, putStoredHints } from './hintCache';
import {
  maiaClientFactory,
  maiaServerCooldown,
  maiaServerKey,
  noteMaiaServerFailure,
} from './hintStore';
import {
  jobPolicyMoves,
  runHintJobs,
  type HintJob,
  type HintRunStatus,
  type HintSourceDetail,
  type MaiaHint,
} from './hints';

export type Side = 'white' | 'black';
const SIDES: readonly Side[] = ['white', 'black'];

/** The committed fallback table (validated once; a broken file fails the tests, not the app). */
export const ELO_CALIBRATION: EloCalibration = EloCalibrationSchema.parse(calibrationJson);

// ---------------------------------------------------------------------------------------------
// Pure parts

/** Offline estimate of one side (never stored). */
export interface FallbackEstimate {
  method: 'fallback';
  /** Rounded to 50, 600…2600. */
  rating: number;
  /** Half-width of the shown band: the curve's residual sd, rounded to 50. */
  sd: number;
  /** Scored positions the mean loss is taken over. */
  positions: number;
  meanLoss: number;
  speed: SpeedClass;
  /** The table is the hand-set provisional curve (no calibration run yet): "rough estimate". */
  provisional: boolean;
}

/**
 * The accuracy-based estimate of `side` (ADR-024 §5): mean win-probability loss over the scored
 * positions (same selection as the Maia estimate) through the calibration table of the game's
 * speed class. Undefined below `ELO_MIN_POSITIONS` positions.
 */
export function fallbackEstimate(
  summary: Pick<ReviewSummary, 'moves'>,
  side: Side,
  lastBookPly: number,
  timeControl?: string,
  table: EloCalibration = ELO_CALIBRATION,
): FallbackEstimate | undefined {
  const plies = selectEloPlies(summary.moves, side, lastBookPly);
  if (plies.length === 0) return undefined;
  const meanLoss = plies.reduce((sum, m) => sum + Math.max(0, m.winProbLoss), 0) / plies.length;
  const speed = speedClass(timeControl);
  const { rating, sd } = fallbackElo(meanLoss, speed, table);
  return {
    method: 'fallback',
    rating,
    sd,
    positions: plies.length,
    meanLoss,
    speed,
    provisional: table.source.month === 'provisional',
  };
}

/** Hints of a game by ply, then by Maia level. */
export type EloHints = Readonly<Record<number, Partial<Record<number, MaiaHint>>>>;

/** A hint that can serve the estimate: it knows whether the played move was in the answer. */
export const eloUsable = (h: MaiaHint | undefined): h is MaiaHint =>
  h !== undefined && (h.playedP !== undefined || h.playedExact !== undefined);

/**
 * The Maia estimate from the hints of the scored `plies` at the nine levels (engine-core's
 * `eloLikelihood`). A missing probability (no hint, or the played move outside an older server's
 * top 5) uses the floor and makes the estimate inexact. Undefined when the likelihood gives no
 * estimate (band over all levels) or there are no plies.
 */
export function eloFromHints(
  hints: EloHints,
  plies: readonly number[],
  legalMoves: Readonly<Record<number, number>>,
): EloEstimate | undefined {
  if (plies.length === 0) return undefined;
  const samples: EloSample[] = plies.map((ply) => {
    const p: Partial<Record<MaiaEloLevel, number | undefined>> = {};
    let minP: number | undefined;
    for (const level of MAIA_ELO_LEVELS) {
      const h = hints[ply]?.[level];
      p[level] = h?.playedP;
      if (h?.minP !== undefined) minP = minP === undefined ? h.minP : Math.min(minP, h.minP);
    }
    return { ply, legalMoves: legalMoves[ply] ?? 30, p, ...(minP !== undefined ? { minP } : {}) };
  });
  const r = eloLikelihood(samples);
  if (r.estimate === undefined) return undefined;
  const clamp = (x: number) => Math.min(2200, Math.max(800, Math.round(x)));
  return {
    method: 'maia',
    rating: clamp(r.estimate),
    ...(r.low !== undefined ? { low: clamp(r.low) } : {}),
    ...(r.high !== undefined ? { high: clamp(r.high) } : {}),
    ...(r.edge ? { edge: r.edge } : {}),
    positions: plies.length,
    exact: r.exact,
    maiaVersion: MAIA_ELO_VERSION,
  };
}

/** `~1540`, `<1100`, `>1900`. */
export function maiaEloShort(e: Pick<EloEstimate, 'rating' | 'edge'>): string {
  if (e.edge === 'low') return `<${MAIA_ELO_LEVELS[0]}`;
  if (e.edge === 'high') return `>${MAIA_ELO_LEVELS[MAIA_ELO_LEVELS.length - 1]}`;
  return `~${e.rating}`;
}

/** The band "1400–1700"; undefined when open (edge) or a single level. */
export function maiaEloBand(e: Pick<EloEstimate, 'low' | 'high'>): string | undefined {
  return e.low !== undefined && e.high !== undefined && e.low < e.high
    ? `${e.low}–${e.high}`
    : undefined;
}

/** `≈ 1500 ± 300`. */
export const fallbackEloText = (f: Pick<FallbackEstimate, 'rating' | 'sd'>): string =>
  `≈ ${f.rating} ± ${f.sd}`;

export const MAIA_METHOD_TEXT =
  'Maia predicts the moves of lichess players; this is a lichess-style rating, not FIDE or ' +
  'chess.com, and only says how the moves of this game look.';

/** Tooltip of a Maia estimate. */
export function maiaEloTooltip(e: EloEstimate): string {
  const band = maiaEloBand(e);
  return [
    `Estimated from how likely the nine Maia levels (1100–1900) find the moves played in ${e.positions} positions (book moves, forced moves and decided positions left out).`,
    band ? `The band ${band} is a 95% likelihood interval.` : undefined,
    e.edge
      ? 'The moves fit the edge of the Maia range best, so the rating may lie beyond it.'
      : undefined,
    e.exact ? undefined : 'Approximate: the server did not report every move probability.',
    MAIA_METHOD_TEXT,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Tooltip of a fallback estimate. */
export function fallbackEloTooltip(f: FallbackEstimate): string {
  return [
    `Approximate, from accuracy: the average win-probability loss over ${f.positions} positions (${f.meanLoss.toFixed(1)}%) compared with lichess games${f.speed === 'unknown' ? '' : ` at ${f.speed}`}.`,
    f.provisional ? 'Rough estimate: the comparison table is not calibrated yet.' : undefined,
    'One game says little; this describes the moves of this game, not a rating.',
  ]
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------------------------
// Store and runner

export type EloStatus =
  | 'idle'
  /** Maia hints off or the browser-only review setting: fallback only. */
  | 'off'
  | 'running'
  | 'done'
  | 'unavailable'
  | 'unauthorized'
  | 'busy';

export interface EloState {
  status: EloStatus;
  /** Side-levels finished / to do while running ("Estimating… (12 of 18)"). */
  progress: { done: number; total: number };
  /** Maia estimates (stored or computed). */
  estimates: { white?: EloEstimate; black?: EloEstimate };
  /** Offline estimates (always computed; shown while there is no Maia estimate). */
  fallback: { white?: FallbackEstimate; black?: FallbackEstimate };
  /** The engine's side of a Play-tab game: shows nothing. */
  hidden?: Side;
  /** The game store's `moves` array the state belongs to (identity, as the hints). */
  forMoves?: readonly unknown[];
  gameKey?: string;
}

const initial = (): EloState => ({
  status: 'idle',
  progress: { done: 0, total: 0 },
  estimates: {},
  fallback: {},
});

export const useEloStore = create<EloState>()(() => initial());

export interface EloRequest {
  startFen: string;
  /** The game's moves; the array identity is kept as {@link EloState.forMoves}. */
  moves: ReadonlyArray<{ from: string; to: string; promotion?: string }>;
  summary: Pick<ReviewSummary, 'moves'>;
  details: Readonly<Record<number, HintSourceDetail>>;
  /** Last book ply of the game (0 for a custom start position). */
  lastBookPly: number;
  /** PGN `TimeControl` header (speed class of the fallback). */
  timeControl?: string;
  /** Setting `maiaHints`. */
  enabled: boolean;
  /** Setting `reviewEngine`: `browser` never queries the server. */
  reviewEngine: ReviewEnginePreference;
  /** The review record's estimates, when it carries them. */
  storedElo?: StoredElo;
  /** The engine's side (Play tab): no estimate. */
  engineSide?: Side;
  /** The Maia run starts after this settles (the hints run of the same game). */
  after?: Promise<unknown>;
}

/** In-memory hints of the estimate runs (id → hint), least recently used first. */
const memory = new Map<string, MaiaHint>();
export const MAX_MEMORY_ELO_HINTS = 2_000;
/** Found hints are written to the cache in batches of this size (and at the end of the run). */
export const ELO_FLUSH_EVERY = 60;
let current: {
  key: string;
  gameKey: string;
  abort: AbortController;
  promise: Promise<void>;
  unsubscribe: () => void;
} | null = null;

function remember(id: string, hint: MaiaHint): void {
  memory.delete(id);
  memory.set(id, hint);
  while (memory.size > MAX_MEMORY_ELO_HINTS) memory.delete(memory.keys().next().value!);
}

/** Cancels the current run and forgets the state and the in-memory hints (tests, cache clear). */
export function resetEloEstimate(): void {
  stopCurrent();
  memory.clear();
  useEloStore.setState(initial(), true);
}

function stopCurrent(): void {
  current?.abort.abort();
  current?.unsubscribe();
  current = null;
}

const uciOf = (m: { from: string; to: string; promotion?: string }): string =>
  `${m.from}${m.to}${m.promotion ?? ''}`;

function legalMoveCount(fen: string): number | undefined {
  try {
    return new Chess(fen).moves().length;
  } catch {
    return undefined;
  }
}

/**
 * Shows the estimates of a reviewed game and computes the missing Maia estimates. Idempotent for
 * the same game and settings; a different request (another game) cancels the running one, and a
 * change of the game on the board aborts it. Resolves when the run ended (tests).
 *
 * No Maia run (fallback only) with the setting `maiaHints` off, the `browser` review setting, no
 * engine server, or when the record already carries both estimates. A failed server is not asked
 * again during the hint cooldown; a partial run keeps its answers in the hint cache, so the next
 * request only queries what is missing.
 */
export function requestEloEstimate(req: EloRequest): Promise<void> {
  const gameKey = reviewGameKey(req.startFen, req.moves.map(uciOf));
  const hidden = req.engineSide;
  const sides = SIDES.filter((s) => s !== hidden);
  const plies: Record<Side, number[]> = { white: [], black: [] };
  const fallback: EloState['fallback'] = {};
  for (const side of sides) {
    plies[side] = selectEloPlies(req.summary.moves, side, req.lastBookPly).map((m) => m.ply);
    const f = fallbackEstimate(req.summary, side, req.lastBookPly, req.timeControl);
    if (f) fallback[side] = f;
  }
  const estimates: EloState['estimates'] = {};
  for (const side of sides) {
    const e = req.storedElo?.[side];
    if (e && e.maiaVersion === MAIA_ELO_VERSION) estimates[side] = e;
  }
  const needed = sides.filter((s) => plies[s].length > 0 && !estimates[s]);
  const runnable = req.enabled && req.reviewEngine !== 'browser';
  const key = [
    gameKey,
    req.lastBookPly,
    req.timeControl ?? '',
    hidden ?? '',
    runnable,
    needed.join(','),
    maiaServerKey(),
  ].join('|');
  if (current?.key === key && !current.abort.signal.aborted) {
    if (useEloStore.getState().forMoves !== req.moves)
      useEloStore.setState({ forMoves: req.moves });
    return current.promise;
  }
  stopCurrent();
  const abort = new AbortController();
  const signal = abort.signal;
  const isCurrent = () => !signal.aborted;
  // Abort when another game is put on the board (the same game reloaded keeps running).
  let watchedMoves: unknown = useGameStore.getState().moves;
  const unsubscribe = useGameStore.subscribe((g) => {
    if (g.moves === watchedMoves) return;
    watchedMoves = g.moves;
    if (reviewGameKey(g.startFen, g.moves.map(uciOf)) !== gameKey) {
      abort.abort();
      unsubscribe();
    }
  });

  const total = needed.length * MAIA_ELO_LEVELS.length;
  const base: EloState = {
    status: 'idle',
    progress: { done: 0, total: 0 },
    estimates,
    fallback,
    ...(hidden ? { hidden } : {}),
    forMoves: req.moves,
    gameKey,
  };
  const settle = (state: Partial<EloState>, promise: Promise<void> = Promise.resolve()) => {
    useEloStore.setState({ ...base, ...state }, true);
    unsubscribe();
    current = { key, gameKey, abort, promise, unsubscribe };
    return promise;
  };
  if (!runnable) return settle({ status: 'off' });
  if (needed.length === 0) return settle({ status: 'done' });
  useEloStore.setState({ ...base, status: 'running', progress: { done: 0, total } }, true);

  const finish = (state: Partial<EloState>) => {
    if (isCurrent()) useEloStore.setState(state);
  };

  const promise = (async () => {
    await (req.after ?? Promise.resolve()).catch(() => undefined);
    if (!isCurrent()) return;

    // Level-major: every scored ply of both sides at 1100, then at 1200, …
    const jobs: HintJob[] = [];
    const groupOf = new Map<HintJob, string>();
    const legalMoves: Record<number, number> = {};
    for (const side of needed) {
      for (const ply of plies[side]) {
        const d = req.details[ply];
        const n = d ? legalMoveCount(d.fenBefore) : undefined;
        if (n !== undefined) legalMoves[ply] = n;
      }
    }
    for (const level of MAIA_ELO_LEVELS) {
      for (const side of needed) {
        for (const ply of plies[side]) {
          const d = req.details[ply];
          if (!d) continue;
          const job: HintJob = {
            ply,
            rating: level,
            fenBefore: d.fenBefore,
            playedUci: d.playedUci,
            ...(d.bestUci ? { bestUci: d.bestUci } : {}),
            policyMoves: jobPolicyMoves(d.playedUci, d.bestUci),
          };
          jobs.push(job);
          groupOf.set(job, `${side}|${level}`);
        }
      }
    }

    const hints: Record<number, Partial<Record<number, MaiaHint>>> = {};
    const put = (h: MaiaHint) => {
      (hints[h.ply] ??= {})[h.rating] = h;
    };
    const idOf = (j: HintJob) => hintId(gameKey, j.ply, j.rating);
    for (const j of jobs) {
      const h = memory.get(idOf(j));
      if (eloUsable(h)) put(h);
    }
    let missing = jobs.filter((j) => !eloUsable(hints[j.ply]?.[j.rating]));
    if (missing.length > 0) {
      for (const s of await getStoredHints(missing.map(idOf))) {
        if (!eloUsable(s.hint)) continue;
        remember(s.id, s.hint);
        put(s.hint);
      }
      missing = missing.filter((j) => !eloUsable(hints[j.ply]?.[j.rating]));
    }
    if (!isCurrent()) return;

    // Progress per side and level: a group is done when none of its jobs is missing any more.
    const open = new Map<string, number>();
    for (const side of needed) for (const level of MAIA_ELO_LEVELS) open.set(`${side}|${level}`, 0);
    for (const j of missing) {
      const g = groupOf.get(j)!;
      open.set(g, (open.get(g) ?? 0) + 1);
    }
    const doneGroups = () => [...open.values()].filter((n) => n === 0).length;
    finish({ progress: { done: doneGroups(), total } });

    const compute = (): EloState['estimates'] => {
      const out: EloState['estimates'] = { ...estimates };
      for (const side of needed) {
        const e = eloFromHints(hints, plies[side], legalMoves);
        if (e) out[side] = e;
      }
      return out;
    };

    let status: HintRunStatus = 'done';
    if (missing.length > 0) {
      const factory = maiaClientFactory();
      if (!factory) return finish({ status: 'unavailable' });
      const cooling = maiaServerCooldown();
      if (cooling) return finish({ status: cooling });

      let pending: { id: string; hint: MaiaHint }[] = [];
      const flush = async () => {
        const batch = pending;
        pending = [];
        await putStoredHints(batch);
      };
      const writes: Promise<void>[] = [];
      status = await runHintJobs(missing, {
        ...hintTiming(),
        createClient: factory,
        signal,
        onHint: (h) => {
          const id = hintId(gameKey, h.ply, h.rating);
          remember(id, h);
          put(h);
          pending.push({ id, hint: h });
          if (pending.length >= ELO_FLUSH_EVERY) writes.push(flush());
        },
        onJobDone: (j) => {
          const g = groupOf.get(j);
          if (g === undefined) return;
          open.set(g, Math.max(0, (open.get(g) ?? 1) - 1));
          finish({ progress: { done: doneGroups(), total } });
        },
      });
      writes.push(flush());
      await Promise.all(writes);
      noteMaiaServerFailure(status);
    }
    if (status === 'aborted' || !isCurrent()) return;
    if (status !== 'done') return finish({ status });

    const computed = compute();
    const fresh: StoredElo = {};
    for (const side of needed) if (computed[side]) fresh[side] = computed[side];
    // Shown first: writing the record updates the review store, which re-requests (a no-op or a
    // settle with the same estimates) and must not hide the result of this run.
    finish({ status: 'done', estimates: computed, progress: { done: total, total } });
    if (fresh.white || fresh.black) {
      await writeEloRecord(gameKey, { ...(req.storedElo ?? {}), ...fresh });
    }
  })()
    .catch((err: unknown) => {
      console.warn('Elo estimate failed', err);
      finish({ status: 'unavailable' });
    })
    .finally(unsubscribe);
  current = { key, gameKey, abort, promise, unsubscribe };
  return promise;
}

/** What one side shows: the Maia estimate, else the fallback; undefined = nothing. */
export interface EloView {
  maia?: EloEstimate;
  fallback?: FallbackEstimate;
  /** The Maia run is still going ("Estimating… (12 of 18)"). */
  pending?: { done: number; total: number };
}

/** The view of `side` from a state (pure; the hook and the tour share it). */
export function eloView(s: EloState, side: Side): EloView | undefined {
  if (s.hidden === side) return undefined;
  const maia = s.estimates[side];
  if (maia) return { maia };
  const fallback = s.fallback[side];
  if (!fallback) return undefined;
  return {
    fallback,
    ...(s.status === 'running' ? { pending: s.progress } : {}),
  };
}

/** The view of `side` for the game on the board, else undefined. */
export function useEloView(side: Side): EloView | undefined {
  const s = useEloStore();
  const moves = useGameStore((g) => g.moves);
  if (s.forMoves !== moves) return undefined;
  return eloView(s, side);
}

/** Short form for the tour's finish text: `~1540`, `<1100`, `≈ 1500`. */
export function eloShortText(v: EloView | undefined): string | undefined {
  if (!v) return undefined;
  if (v.maia) return maiaEloShort(v.maia);
  if (v.fallback) return `≈ ${v.fallback.rating}`;
  return undefined;
}

/** Both sides' short texts for the game on the board. */
export function useEloShortTexts(): { white?: string; black?: string } {
  const w = eloShortText(useEloView('white'));
  const b = eloShortText(useEloView('black'));
  return { ...(w ? { white: w } : {}), ...(b ? { black: b } : {}) };
}
