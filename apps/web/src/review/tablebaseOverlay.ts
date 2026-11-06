/**
 * Tablebase overlay of a review (ADR-025 §4): exact verdicts for the plies of the reviewed game
 * whose position before the move has at most 7 pieces. **Additive, derived, never stored**: the
 * engine classification, the accuracy, the summary and the stored record (ADR-016/017) stay
 * unchanged, the overlay is computed from the FENs of the record after a review is `done` or
 * loaded from the cache/server, so `REVIEW_CACHE_VERSION` is not bumped.
 *
 * The run probes the plies one after the other through the tablebase store (cache → local tables
 * → lichess, bounded by the store's queue) and publishes the verdicts as they arrive. It is
 * aborted when the review changes (another game, a new run, a reset), when the setting becomes
 * `off` (the overlay is cleared) and — through the tablebase store — when the game on the board
 * changes or a human game starts. A setting change from `off` (or one that may answer plies the
 * last run missed) recomputes it.
 *
 * This module does not import `reviewStore` at runtime (the review store installs the overlay
 * with {@link installTablebaseOverlay}, passing itself), so the two modules form no cycle.
 */
import { Chess } from 'chess.js';
import {
  judgeMove,
  pieceCount,
  TABLEBASE_MAX_PIECES,
  tablebaseEligible,
  type TbVerdict,
} from '@daisychess/endgames';
import { abortError } from '../endgames/lichessTablebase';
import {
  isAbortError,
  resolveTablebase,
  type TbResolution,
  type TbSource,
} from '../endgames/tablebaseStore';
import { useSettingsStore, type TablebaseSetting } from '../store/settingsStore';
import type { GameState } from '../store/gameStore';
import type { MoveDetail, MoveDetails } from './details';

/**
 * A verdict of the overlay: the package's {@link TbVerdict} plus the distances of the position
 * after the played move (from the point of view of the side to move there, i.e. the opponent),
 * which the explainer quotes ("a tablebase loss after it (mate in 23)").
 */
export interface ReviewTbVerdict extends TbVerdict {
  dtmAfter?: number;
  dtzAfter?: number;
}

export type TbOverlayStatus = 'idle' | 'running' | 'done' | 'unavailable';

export interface TbOverlay {
  /**
   * `running` while plies are probed (verdicts arrive progressively), `done` when every eligible
   * ply was probed (some may have no answer, see `missed`), `unavailable` when no eligible ply got
   * an answer (offline, rate limited, tables not downloaded), `idle` when the run was aborted from
   * outside (game change, human game).
   */
  status: TbOverlayStatus;
  /** Where the answers came from; `mixed` when both sources answered. */
  source?: TbSource | 'mixed';
  /** Verdicts by ply (1-based, like `moveDetails`). */
  verdicts: Record<number, ReviewTbVerdict>;
  /** Eligible plies without an answer so far. */
  missed: number;
  /** The review's `reviewed` moves the overlay belongs to (identity). */
  reviewed?: GameState['moves'];
}

/** The review state fields the overlay reads and writes. */
export interface OverlayReviewState {
  status: string;
  summary?: unknown;
  moveDetails: MoveDetails;
  reviewed?: GameState['moves'];
  tablebase?: TbOverlay;
}

/** The part of a zustand store API the installer needs. */
export interface OverlayStoreApi<S extends OverlayReviewState> {
  getState(): S;
  setState(partial: Partial<S>): void;
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

export type TbResolver = (fen: string, opts: { signal: AbortSignal }) => Promise<TbResolution>;

let resolver: TbResolver = resolveTablebase;

/** Tests: replaces the resolver of runs started afterwards (`undefined` restores the store's). */
export function setOverlayResolver(fn: TbResolver | undefined): void {
  resolver = fn ?? resolveTablebase;
}

/** Plies whose position before the move can be looked up, ascending. */
export function eligiblePlies(details: MoveDetails): number[] {
  const eligible = (d: MoveDetail | undefined): boolean =>
    d !== undefined &&
    pieceCount(d.fenBefore) <= TABLEBASE_MAX_PIECES &&
    tablebaseEligible(d.fenBefore);
  return Object.keys(details)
    .map(Number)
    .filter((ply) => Number.isInteger(ply) && eligible(details[ply]))
    .sort((a, b) => a - b);
}

/** The overlay's verdict of `uci` in an answered position, with the distances after the move. */
export function verdictOf(
  pos: Parameters<typeof judgeMove>[0],
  uci: string,
): ReviewTbVerdict | undefined {
  const v = judgeMove(pos, uci);
  if (!v) return undefined;
  const move = pos.moves.find((m) => m.uci === v.uci);
  const out: ReviewTbVerdict = { ...v };
  if (move?.dtm !== undefined) out.dtmAfter = move.dtm;
  if (move?.dtz !== undefined) out.dtzAfter = move.dtz;
  return out;
}

export interface OverlayRunOptions {
  signal: AbortSignal;
  resolve?: TbResolver;
  /** Called after every probed ply with the overlay so far (status `running`). */
  onProgress?: (overlay: TbOverlay) => void;
}

/** Result of {@link computeOverlay}; `stop` says why it ended early. */
export interface OverlayRunResult {
  overlay: TbOverlay;
  stop?: 'off' | 'locked';
}

const mergeSource = (a: TbOverlay['source'], b: TbSource): NonNullable<TbOverlay['source']> =>
  a === undefined || a === b ? b : 'mixed';

/**
 * Probes every eligible ply of `details` in order and judges the played move. Rejects with an
 * AbortError when `signal` aborts. Stops early (without rejecting) when the store refuses with
 * `off` or `locked`.
 */
export async function computeOverlay(
  details: MoveDetails,
  opts: OverlayRunOptions,
): Promise<OverlayRunResult> {
  const resolve = opts.resolve ?? resolver;
  const plies = eligiblePlies(details);
  let overlay: TbOverlay = { status: 'running', verdicts: {}, missed: 0 };
  let answered = 0;
  for (const ply of plies) {
    const d = details[ply]!;
    if (opts.signal.aborted) throw abortError();
    const r = await resolve(d.fenBefore, { signal: opts.signal });
    if (opts.signal.aborted) throw abortError();
    if (!r.ok) {
      if (r.reason === 'off' || r.reason === 'locked') return { overlay, stop: r.reason };
      overlay = { ...overlay, missed: overlay.missed + 1 };
    } else {
      answered++;
      const v = verdictOf(r.answer.pos, d.playedUci);
      overlay = {
        ...overlay,
        source: mergeSource(overlay.source, r.answer.source),
        ...(v ? { verdicts: { ...overlay.verdicts, [ply]: v } } : {}),
      };
    }
    opts.onProgress?.(overlay);
  }
  const status: TbOverlayStatus = plies.length > 0 && answered === 0 ? 'unavailable' : 'done';
  return { overlay: { ...overlay, status } };
}

/**
 * The verdict of `ply` when the overlay belongs to the shown review (selector for components:
 * `useReviewStore((s) => tbVerdictAt(s, ply))`).
 */
export function tbVerdictAt(
  s: Pick<OverlayReviewState, 'tablebase' | 'reviewed'>,
  ply: number,
): ReviewTbVerdict | undefined {
  const t = s.tablebase;
  if (!t || t.reviewed !== s.reviewed) return undefined;
  return t.verdicts[ply];
}

/** The verdicts for the tour: only a finished overlay of the shown review (ADR-025 §4). */
export function doneVerdicts(
  s: Pick<OverlayReviewState, 'tablebase' | 'reviewed' | 'status'>,
): Readonly<Record<number, ReviewTbVerdict>> | undefined {
  const t = s.tablebase;
  if (s.status !== 'done' || !t || t.status !== 'done' || t.reviewed !== s.reviewed)
    return undefined;
  return t.verdicts;
}

/**
 * Wires the overlay to the review store: starts a run whenever a review becomes `done` (computed
 * or loaded) or the done review changes, aborts and clears it when the review leaves `done`,
 * clears it when the setting becomes `off` and recomputes it when the setting changes from `off`
 * (or while the last run missed plies). Returns the unsubscribe.
 */
export function installTablebaseOverlay<S extends OverlayReviewState>(
  store: OverlayStoreApi<S>,
  settings: {
    get: () => TablebaseSetting;
    subscribe: (fn: (now: TablebaseSetting, prev: TablebaseSetting) => void) => () => void;
  } = {
    get: () => useSettingsStore.getState().tablebase,
    subscribe: (fn) =>
      useSettingsStore.subscribe((s, prev) => {
        if (s.tablebase !== prev.tablebase) fn(s.tablebase, prev.tablebase);
      }),
  },
): () => void {
  let ctl: AbortController | null = null;

  const abort = () => {
    ctl?.abort();
    ctl = null;
  };

  const clear = () => {
    abort();
    if (store.getState().tablebase !== undefined) {
      store.setState({ tablebase: undefined } as Partial<S>);
    }
  };

  const start = () => {
    abort();
    const s = store.getState();
    if (s.status !== 'done' || !s.summary || settings.get() === 'off') {
      clear();
      return;
    }
    const reviewed = s.reviewed;
    const details = s.moveDetails;
    if (eligiblePlies(details).length === 0) {
      // Nothing to look up: no overlay (and no request).
      if (s.tablebase !== undefined) store.setState({ tablebase: undefined } as Partial<S>);
      return;
    }
    const my = new AbortController();
    ctl = my;
    const publish = (t: Omit<TbOverlay, 'reviewed'>) => {
      if (ctl !== my) return;
      store.setState({ tablebase: { ...t, ...(reviewed ? { reviewed } : {}) } } as Partial<S>);
    };
    publish({ status: 'running', verdicts: {}, missed: 0 });
    computeOverlay(details, { signal: my.signal, onProgress: publish }).then(
      (r) => {
        if (ctl !== my) return;
        if (r.stop === 'off') {
          clear();
          return;
        }
        publish(r.stop === 'locked' ? { ...r.overlay, status: 'idle' } : r.overlay);
        ctl = null;
      },
      (e: unknown) => {
        if (ctl !== my) return;
        if (!isAbortError(e)) console.warn('Tablebase overlay failed', e);
        // Aborted from outside (game change, human game) or failed: keep what arrived.
        const cur = store.getState().tablebase;
        if (cur) publish({ ...cur, status: 'idle' });
        ctl = null;
      },
    );
  };

  const unwatchReview = store.subscribe((s, prev) => {
    if (s.status !== 'done' || !s.summary) {
      if (prev.status === 'done' || ctl || s.tablebase !== undefined) clear();
      return;
    }
    if (
      prev.status === 'done' &&
      s.reviewed === prev.reviewed &&
      s.summary === prev.summary &&
      s.moveDetails === prev.moveDetails
    )
      return;
    start();
  });

  const unwatchSetting = settings.subscribe((now, prev) => {
    if (now === 'off') {
      clear();
      return;
    }
    const t = store.getState().tablebase;
    const incomplete = !t || t.status !== 'done' || t.missed > 0;
    if (prev === 'off' || incomplete) start();
  });

  // A review that is already done when the overlay is installed.
  if (store.getState().status === 'done') start();

  return () => {
    unwatchReview();
    unwatchSetting();
    abort();
  };
}

// ---------------------------------------------------------------------------------------------
// Display texts (move list badge, move card line). Mover's point of view, SAN, never "you".

/** The badge kind: an `only` move in a lost position is shown as `kept` (nothing to keep). */
export function tbDisplayKind(v: Pick<TbVerdict, 'kind' | 'before'>): TbVerdict['kind'] {
  return v.kind === 'only' && v.before === 'loss' ? 'kept' : v.kind;
}

/** `title`/`aria-label` of the move list's `TB` badge. */
export function tbBadgeTitle(v: Pick<TbVerdict, 'kind' | 'before' | 'after'>): string {
  switch (tbDisplayKind(v)) {
    case 'thrown':
      return `Tablebase: throws away the ${v.before === 'win' ? 'win' : 'draw'}`;
    case 'only':
      return 'Tablebase: only move';
    default:
      return v.before === 'loss' ? 'Tablebase: still lost' : `Tablebase: keeps the ${v.before}`;
  }
}

/** SAN of `uci` in `fen` (undefined when it is not legal there). */
function sanOf(fen: string, uci: string): string | undefined {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
  if (!m) return undefined;
  try {
    return new Chess(fen).move({ from: m[1]!, to: m[2]!, promotion: m[3] }).san;
  } catch {
    return undefined;
  }
}

/** ` (mate in 23)` for the opponent after the move, when the distance is known. */
const mateAfter = (v: ReviewTbVerdict): string =>
  v.after === 'loss' && v.dtmAfter !== undefined && v.dtmAfter !== 0
    ? ` (mate in ${Math.ceil(Math.abs(v.dtmAfter) / 2)})`
    : '';

/**
 * The move card's tablebase line (ADR-025 §4), e.g. "Tablebase: Rd1+ throws away the win — after
 * it the position is a draw; Rc4 was the only move that keeps it." / "Only move (tablebase): Rc4
 * keeps the win." / "Tablebase draw after Kf3.". `fenBefore` turns the keeper's UCI into SAN.
 */
export function tbCommentaryText(v: ReviewTbVerdict, fenBefore: string): string {
  const played = v.san;
  switch (tbDisplayKind(v)) {
    case 'thrown': {
      const keeperUci = v.keepers[0];
      const keeper = keeperUci ? sanOf(fenBefore, keeperUci) : undefined;
      const now = v.after === 'draw' ? 'a draw' : `lost${mateAfter(v)}`;
      const verb = v.before === 'win' ? 'throws away the win' : 'loses';
      const keeps = v.before === 'win' ? 'keeps it' : 'holds the draw';
      const tail = !keeper
        ? ''
        : v.keepers.length === 1
          ? `; ${keeper} was the only move that ${keeps}`
          : `; ${keeper} ${keeps}`;
      return `Tablebase: ${played} ${verb} — after it the position is ${now}${tail}.`;
    }
    case 'only':
      return `Only move (tablebase): ${played} ${v.before === 'win' ? 'keeps the win' : 'holds the draw'}.`;
    default:
      return `Tablebase ${v.after} after ${played}${mateAfter(v)}.`;
  }
}
