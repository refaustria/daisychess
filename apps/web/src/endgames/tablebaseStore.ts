/**
 * Tablebase store (ADR-025 §2): one entry point for every tablebase consumer — the analysis
 * board (`lookup`), the review overlay and the explainer (`probe`/`resolve`, M32-7), the
 * trainer's opponent (`tablebaseProbe`, M32-8) — plus the opt-in pack state for Settings and
 * the Endgames tab.
 *
 * Source order of {@link resolveTablebase}:
 * 1. refused: setting `off` (not for `purpose: 'trainer'`, which then uses local tables only), a live/room/engine game running (`humanGameLockReason()`, fair
 *    play), or the position is not eligible (more than 7 pieces, castling rights, invalid FEN);
 * 2. the position cache (IndexedDB `tb`: lichess answers, keyed by FEN without the move number);
 * 3. the local Syzygy tables when every table of the position's closure is bundled or downloaded
 *    (instant, no network — preferred even online) …
 * 4. … except when only WDL is local (no DTZ for the material) and the halfmove clock is at
 *    least {@link HIGH_HALFMOVE}: WDL alone assumes a fresh 50-move counter, so with the setting
 *    `online` the lichess API is asked first and the local answer is the fallback (ADR-025
 *    addendum M32-2);
 * 5. the lichess API (setting `online`, source not cooling down); answers go into the cache;
 * 6. otherwise no answer, with a reason (`needs-download` when the missing tables are in an
 *    opt-in pack).
 *
 * Aborts: every probe may pass an `AbortSignal`; aborted probes reject with an `AbortError`
 * (`isAbortError`). The store also aborts **all** running probes when the game in the game store
 * changes (a different start position or a history that is not an extension or a take-back of
 * the previous one), when a human game starts (fair play) and on `cancelAll()`. A setting change
 * to `local`/`off` cancels the network requests.
 */
import {
  tablebaseEligible,
  type OpponentPolicy,
  type TablebaseProbe,
  type TbPosition,
} from '@daisychess/endgames';
import { create } from 'zustand';
import { humanGameLockReason, type HumanGameLock } from '../live/lock';
import { useLiveStore } from '../live/liveStore';
import { usePlayStore } from '../play/playStore';
import { useRoomStore } from '../room/roomStore';
import { useGameStore, type GameState } from '../store/gameStore';
import { useSettingsStore, type TablebaseSetting } from '../store/settingsStore';
import {
  abortError,
  createLichessTablebase,
  isAbortError,
  type LichessTablebaseClient,
} from './lichessTablebase';
import { createLocalTablebase, type LocalCoverage, type LocalTablebase } from './localTablebase';
import {
  deletePack as deleteStoredPack,
  downloadPack as downloadStoredPack,
  MANIFEST_FILES,
  packStatus,
  PackDownloadError,
  type DownloadProgress,
  type OptInPack,
  type PackStatus,
} from './tablePacks';
import { getCachedPosition, putCachedPosition } from './tbCache';

export { isAbortError };

/** Debounce of {@link TablebaseStore.lookup} (analysis board), like the explorer. */
export const LOOKUP_DEBOUNCE_MS = 300;
/** From this halfmove clock a WDL-only local answer may misread a cursed win: prefer the API. */
export const HIGH_HALFMOVE = 20;

/** Where an answer came from: lichess (API or its cached answer) or the tables on this device. */
export type TbSource = 'lichess' | 'local';

export interface TbAnswer {
  pos: TbPosition;
  source: TbSource;
}

/**
 * Why there is no answer: `off` (setting), `locked` (human game), `ineligible` (> 7 pieces,
 * castling rights, invalid FEN), `needs-download` (the tables are in an opt-in pack that is not
 * downloaded, and the network did not answer), `unavailable` (no source answered: offline,
 * rate limited, setting `local` without tables, or no exact data).
 */
export type TbMissReason = 'off' | 'locked' | 'ineligible' | 'needs-download' | 'unavailable';

export type TbResolution =
  { ok: true; answer: TbAnswer } | { ok: false; reason: TbMissReason; pack?: OptInPack };

export interface ProbeOptions {
  signal?: AbortSignal;
  /**
   * `trainer`: the endgame lessons. The setting `off` then behaves like `local` (bundled and
   * downloaded tables only, never lichess); analysis and review stay off.
   */
  purpose?: 'trainer';
}

// ---------------------------------------------------------------------------------------------
// Dependencies (tests replace them)

export interface TablebaseDeps {
  lichess: LichessTablebaseClient;
  local: LocalTablebase;
  cache: {
    get: (fen: string) => Promise<TbPosition | undefined>;
    put: (fen: string, pos: TbPosition) => Promise<void>;
  };
  lock: () => HumanGameLock;
  setting: () => TablebaseSetting;
}

let deps: TablebaseDeps | null = null;

function defaultDeps(): TablebaseDeps {
  return {
    lichess: createLichessTablebase(),
    local: createLocalTablebase(),
    cache: { get: getCachedPosition, put: putCachedPosition },
    lock: humanGameLockReason,
    setting: () => useSettingsStore.getState().tablebase,
  };
}

const d = (): TablebaseDeps => (deps ??= defaultDeps());

/** Tests: replace some dependencies (the rest keep their defaults); `null` resets all. */
export function configureTablebase(patch: Partial<TablebaseDeps> | null): void {
  cancelAllProbes();
  deps = patch === null ? null : { ...d(), ...patch };
}

// ---------------------------------------------------------------------------------------------
// Probing

/** Controllers of the running probes (aborted together by `cancelAll`). */
const running = new Set<AbortController>();

function cancelAllProbes(): void {
  for (const c of [...running]) c.abort();
  running.clear();
}

/** Combines the caller's signal with the store's own controller. */
function track(signal: AbortSignal | undefined): { ctl: AbortController; done: () => void } {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  running.add(ctl);
  return {
    ctl,
    done: () => {
      running.delete(ctl);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

const halfmoveClock = (fen: string): number => {
  const n = Number(fen.trim().split(/\s+/)[4] ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** The opt-in pack all missing files belong to, if any. */
function packOf(missing: readonly string[]): OptInPack | undefined {
  if (missing.length === 0) return undefined;
  const packs = new Set(missing.map((f) => MANIFEST_FILES.get(f)?.pack));
  return packs.size === 1 && packs.has('rook') ? 'rook' : undefined;
}

/** The immediate refusal for `fen`, if any (no I/O). */
function refusal(fen: string, purpose?: 'trainer'): TbMissReason | null {
  const { setting, lock } = d();
  if (setting() === 'off' && purpose !== 'trainer') return 'off';
  if (lock() !== null) return 'locked';
  if (!tablebaseEligible(fen)) return 'ineligible';
  return null;
}

/** Full resolution of `fen` with the source order of the module comment. */
export async function resolveTablebase(
  fen: string,
  opts: ProbeOptions = {},
): Promise<TbResolution> {
  const refused = refusal(fen, opts.purpose);
  if (refused) return { ok: false, reason: refused };
  const { lichess, local, cache, setting, lock } = d();
  const { ctl, done } = track(opts.signal);
  const signal = ctl.signal;
  const check = () => {
    if (signal.aborted) throw abortError();
  };
  try {
    check();
    const cached = await cache.get(fen);
    check();
    if (cached) return { ok: true, answer: { pos: cached, source: 'lichess' } };

    let cov: LocalCoverage;
    try {
      cov = await local.coverage(fen);
    } catch {
      cov = { wdl: false, dtz: false, missing: [] };
    }
    check();
    const online = () => setting() === 'online' && lichess.available() && lock() === null;
    const preferApi = cov.wdl && !cov.dtz && halfmoveClock(fen) >= HIGH_HALFMOVE && online();

    const tryLocal = async (): Promise<TbResolution | null> => {
      let pos: TbPosition | null = null;
      try {
        pos = await local.probe(fen, { signal });
      } catch (e) {
        if (isAbortError(e)) throw e;
      }
      check();
      return pos ? { ok: true, answer: { pos, source: 'local' } } : null;
    };

    if (cov.wdl && !preferApi) {
      const r = await tryLocal();
      if (r) return r;
    }
    if (online()) {
      const pos = await lichess.probe(fen, { signal });
      check();
      if (lock() !== null) return { ok: false, reason: 'locked' };
      if (pos) {
        void cache.put(fen, pos);
        return { ok: true, answer: { pos, source: 'lichess' } };
      }
    }
    if (preferApi) {
      const r = await tryLocal();
      if (r) return r;
    }
    const pack = cov.wdl ? undefined : packOf(cov.missing);
    return pack
      ? { ok: false, reason: 'needs-download', pack }
      : { ok: false, reason: 'unavailable' };
  } finally {
    done();
  }
}

/** `TablebaseProbe.probe` over {@link resolveTablebase}: the position or null. */
export async function probeTablebase(
  fen: string,
  opts: ProbeOptions = {},
): Promise<TbPosition | null> {
  const r = await resolveTablebase(fen, opts);
  return r.ok ? r.answer.pos : null;
}

/** The `TablebaseProbe` for `opponentMove` and other package functions. */
export const tablebaseProbe: TablebaseProbe = { probe: (fen) => probeTablebase(fen) };

/** The probe of the trainer's opponent: like {@link tablebaseProbe}, but works under `off`. */
export const trainerProbe: TablebaseProbe = {
  probe: (fen) => probeTablebase(fen, { purpose: 'trainer' }),
};

/**
 * The trainer's opponent policy for an answer (ADR-025 §6): `dtz` with DTZ data (lichess, or
 * local WDL+DTZ), `wdlTrappy` for WDL-only local tables.
 */
export function opponentPolicyFor(answer: TbAnswer): OpponentPolicy {
  return answer.source === 'lichess' || answer.pos.dtz !== undefined ? 'dtz' : 'wdlTrappy';
}

/** What the local tables cover for `fen` (lesson source selection, M32-8). */
export function localCoverage(fen: string): Promise<LocalCoverage> {
  return d().local.coverage(fen);
}

// ---------------------------------------------------------------------------------------------
// Store

export type TbLookupStatus = 'idle' | 'loading' | 'done' | 'unavailable' | 'disabled';

export interface TbLookup {
  fen: string | null;
  status: TbLookupStatus;
  answer?: TbAnswer;
  /** `disabled`: off / locked / ineligible; `unavailable`: needs-download / unavailable. */
  reason?: TbMissReason;
  /** `needs-download`: the pack that would answer offline. */
  pack?: OptInPack;
}

export interface PackUi {
  status: PackStatus | null;
  busy: 'download' | 'delete' | null;
  progress: DownloadProgress | null;
  error: string | null;
}

export interface TablebaseState {
  /** The analysis-board lookup (`lookup(fen)`). */
  current: TbLookup;
  packs: Record<OptInPack, PackUi>;
}

export interface TablebaseActions {
  /** {@link probeTablebase}. */
  probe: (fen: string, opts?: ProbeOptions) => Promise<TbPosition | null>;
  /** {@link resolveTablebase}. */
  resolve: (fen: string, opts?: ProbeOptions) => Promise<TbResolution>;
  /**
   * Debounced ({@link LOOKUP_DEBOUNCE_MS}) lookup for the analysis board into `current`; `null`
   * clears it. Refusals (off, locked, ineligible) show at once without a request.
   */
  lookup: (fen: string | null) => void;
  /** Aborts every running probe and the pending lookup. */
  cancelAll: () => void;
  refreshPacks: () => Promise<void>;
  downloadPack: (pack: OptInPack) => Promise<void>;
  cancelDownload: () => void;
  deletePack: (pack: OptInPack) => Promise<void>;
}

export type TablebaseStore = TablebaseState & TablebaseActions;

const idlePack = (): PackUi => ({ status: null, busy: null, progress: null, error: null });
const IDLE: TbLookup = { fen: null, status: 'idle' };

let lookupTimer: ReturnType<typeof setTimeout> | null = null;
let lookupCtl: AbortController | null = null;
let downloadCtl: AbortController | null = null;

function stopLookup(): void {
  if (lookupTimer) clearTimeout(lookupTimer);
  lookupTimer = null;
  lookupCtl?.abort();
  lookupCtl = null;
}

const DISABLED: readonly TbMissReason[] = ['off', 'locked', 'ineligible'];

export const useTablebaseStore = create<TablebaseStore>()((set, get) => {
  const runLookup = (fen: string, delay: number) => {
    stopLookup();
    const refused = refusal(fen);
    if (refused) {
      set({ current: { fen, status: 'disabled', reason: refused } });
      return;
    }
    set({ current: { fen, status: 'loading' } });
    lookupTimer = setTimeout(() => {
      lookupTimer = null;
      const ctl = new AbortController();
      lookupCtl = ctl;
      resolveTablebase(fen, { signal: ctl.signal }).then(
        (r) => {
          if (lookupCtl !== ctl) return;
          lookupCtl = null;
          if (r.ok) set({ current: { fen, status: 'done', answer: r.answer } });
          else {
            const status = DISABLED.includes(r.reason) ? 'disabled' : 'unavailable';
            set({
              current: { fen, status, reason: r.reason, ...(r.pack ? { pack: r.pack } : {}) },
            });
          }
        },
        (e: unknown) => {
          if (lookupCtl === ctl) lookupCtl = null;
          if (!isAbortError(e)) console.warn('Tablebase lookup failed', e);
          // Aborted by a game change or cancelAll: an unchanged FEN must be looked up again.
          if (get().current.fen === fen && get().current.status === 'loading') {
            set({ current: IDLE });
          }
        },
      );
    }, delay);
  };

  return {
    current: IDLE,
    packs: { rook: idlePack() },

    probe: probeTablebase,
    resolve: resolveTablebase,

    lookup: (fen) => {
      if (fen === null) {
        stopLookup();
        if (get().current !== IDLE) set({ current: IDLE });
        return;
      }
      const cur = get().current;
      if (cur.fen === fen && cur.status !== 'idle') return;
      runLookup(fen, LOOKUP_DEBOUNCE_MS);
    },

    cancelAll: () => {
      stopLookup();
      cancelAllProbes();
      if (get().current.status === 'loading') set({ current: IDLE });
    },

    refreshPacks: async () => {
      const status = await packStatus('rook');
      set((s) => ({ packs: { ...s.packs, rook: { ...s.packs.rook, status } } }));
    },

    downloadPack: async (pack) => {
      if (get().packs[pack].busy) return;
      const ctl = new AbortController();
      downloadCtl = ctl;
      const patch = (p: Partial<PackUi>) =>
        set((s) => ({ packs: { ...s.packs, [pack]: { ...s.packs[pack], ...p } } }));
      patch({ busy: 'download', error: null, progress: null });
      try {
        const status = await downloadStoredPack(pack, {
          signal: ctl.signal,
          onProgress: (progress) => patch({ progress }),
        });
        patch({ status });
      } catch (e) {
        const aborted = e instanceof PackDownloadError && e.kind === 'aborted';
        patch({
          error: aborted ? null : e instanceof Error ? e.message : 'Download failed',
          status: await packStatus(pack),
        });
      } finally {
        if (downloadCtl === ctl) downloadCtl = null;
        d().local.reset();
        patch({ busy: null, progress: null });
        // A lookup that waited for these tables gets a new chance.
        const cur = get().current;
        if (cur.fen && cur.status === 'unavailable') runLookup(cur.fen, 0);
      }
    },

    cancelDownload: () => downloadCtl?.abort(),

    deletePack: async (pack) => {
      if (get().packs[pack].busy) return;
      const patch = (p: Partial<PackUi>) =>
        set((s) => ({ packs: { ...s.packs, [pack]: { ...s.packs[pack], ...p } } }));
      patch({ busy: 'delete', error: null });
      try {
        await deleteStoredPack(pack);
      } finally {
        d().local.reset({ terminate: true });
        patch({ busy: null, status: await packStatus(pack) });
        const cur = get().current;
        if (cur.fen && cur.answer?.source === 'local') runLookup(cur.fen, 0);
      }
    },
  };
});

// ---------------------------------------------------------------------------------------------
// Subscriptions: settings, fair-play lock, game changes

/** Whether `next` is the same game as `prev` (same start, one history a prefix of the other). */
export function sameGame(
  prev: Pick<GameState, 'startFen' | 'moves'>,
  next: Pick<GameState, 'startFen' | 'moves'>,
): boolean {
  if (prev.startFen !== next.startFen) return false;
  const n = Math.min(prev.moves.length, next.moves.length);
  for (let i = 0; i < n; i++) if (prev.moves[i]!.san !== next.moves[i]!.san) return false;
  return true;
}

function rerunCurrent(): void {
  const cur = useTablebaseStore.getState().current;
  if (cur.fen === null) return;
  useTablebaseStore.setState({ current: IDLE });
  useTablebaseStore.getState().lookup(cur.fen);
}

useSettingsStore.subscribe((s, prev) => {
  if (s.tablebase === prev.tablebase) return;
  if (s.tablebase !== 'online') d().lichess.abortAll();
  if (s.tablebase === 'off') cancelAllProbes();
  rerunCurrent();
});

let lastLock: HumanGameLock = null;
const onLockChange = () => {
  const lock = d().lock();
  if (lock === lastLock) return;
  lastLock = lock;
  if (lock !== null) {
    // Fair play: nothing keeps running and nothing stays on screen during a human game.
    useTablebaseStore.getState().cancelAll();
    d().lichess.abortAll();
  }
  rerunCurrent();
};
usePlayStore.subscribe(onLockChange);
useLiveStore.subscribe(onLockChange);
useRoomStore.subscribe(onLockChange);

useGameStore.subscribe((s, prev) => {
  if (s.startFen === prev.startFen && s.moves === prev.moves) return;
  if (!sameGame(prev, s)) cancelAllProbes();
});

/** Tests: forget the store state and the pending timers. */
export function resetTablebaseStore(): void {
  stopLookup();
  cancelAllProbes();
  downloadCtl?.abort();
  downloadCtl = null;
  lastLock = null;
  useTablebaseStore.setState({ current: IDLE, packs: { rook: idlePack() } });
}
