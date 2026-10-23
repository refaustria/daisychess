import type { EngineInfo, Limits, Score } from '@chesslab/engine-core';
import { Chess } from 'chess.js';
import { create } from 'zustand';
import {
  AnalysisController,
  type AnalysisEngine,
  type AnalysisSettings as ControllerSettings,
  type AnalysisStatus,
  type EngineCapabilities,
  type TerminalKind,
} from '../engine/AnalysisController';
import { currentFen, useGameStore } from './gameStore';

export type { AnalysisStatus, EngineCapabilities, TerminalKind };

export type Backend = 'wasm' | 'remote';
export type BackendStatus = 'connecting' | 'ready' | 'closed' | 'error';

export interface AnalysisSettings extends ControllerSettings {
  /** Which engine runs the analysis: the in-browser WASM build or the native server. */
  backend: Backend;
  /** WebSocket URL of the engine server (dev/e2e; default derived from the page host). Not shown in the UI. */
  remoteUrl?: string;
}

/** One principal variation (scores are White-POV, moves in UCI notation). */
export interface AnalysisLine {
  multipv: number;
  score: Score;
  depth: number;
  pv: string[];
  nps?: number;
  nodes?: number;
  time?: number;
}

export interface AnalysisState {
  enabled: boolean;
  status: AnalysisStatus;
  error?: string;
  engineName?: string;
  capabilities?: EngineCapabilities;
  settings: AnalysisSettings;
  /** Position the lines belong to (follows the game store's current FEN). */
  fen: string;
  /** Set for checkmate/stalemate positions, which are not analysed (`lines` stays empty). */
  terminal: TerminalKind | null;
  /** Sorted by `multipv` (1 = best line). */
  lines: AnalysisLine[];
  /** Engine's best move (UCI) once the search reached the depth limit. */
  bestMove?: string;
  /** Connection state of the remote engine (undefined for the browser engine). */
  backendStatus?: BackendStatus;
  /** User-facing reason for a remote failure ("Server unreachable", "Connection lost", ...). */
  backendError?: string;
  /** Limits announced by the server (after a successful connect). */
  remoteLimits?: Limits;
}

export interface AnalysisActions {
  setEnabled(enabled: boolean): void;
  setSettings(settings: Partial<AnalysisSettings>): void;
  /** Re-creates the engine after an error. */
  retry(): void;
  /** Internal: feeds a position to the controller (normally driven by {@link startAnalysisController}). */
  analysePosition(fen: string): void;
}

export type AnalysisStore = AnalysisState & AnalysisActions;

export const MAX_DEPTH = 40;
export const MAX_MULTIPV = 5;
export const DEFAULT_SETTINGS: AnalysisSettings = { depth: 22, multipv: 1, backend: 'wasm' };
export const STORAGE_KEY = 'chesslab.analysis';

const clampInt = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.round(v)))
    : fallback;

/** Merges a partial update into `base`, clamping depth to 0..40 (0 = infinite) and MultiPV to 1..5. */
export function sanitizeSettings(
  patch: Partial<AnalysisSettings> | null | undefined,
  base: AnalysisSettings = DEFAULT_SETTINGS,
): AnalysisSettings {
  const p = patch ?? {};
  const out: AnalysisSettings = {
    depth: clampInt(p.depth, 0, MAX_DEPTH, base.depth),
    multipv: clampInt(p.multipv, 1, MAX_MULTIPV, base.multipv),
    backend: p.backend === 'wasm' || p.backend === 'remote' ? p.backend : base.backend,
  };
  const remoteUrl = 'remoteUrl' in p ? p.remoteUrl : base.remoteUrl;
  if (typeof remoteUrl === 'string' && /^wss?:\/\/\S{1,200}$/.test(remoteUrl)) {
    out.remoteUrl = remoteUrl;
  }
  const threads = 'threads' in p ? p.threads : base.threads;
  if (threads !== undefined) out.threads = clampInt(threads, 1, 1024, 1);
  return out;
}

/**
 * Replaces the line with the same `multipv` (or inserts it), keeping the array sorted.
 * Infos beyond `maxMultipv` are ignored. Returns a new array.
 */
export function mergeLine(
  lines: AnalysisLine[],
  info: EngineInfo,
  maxMultipv: number,
): AnalysisLine[] {
  if (info.multipv < 1 || info.multipv > maxMultipv) return lines;
  const line: AnalysisLine = {
    multipv: info.multipv,
    score: info.score,
    depth: info.depth,
    pv: info.pv,
    ...(info.nps !== undefined ? { nps: info.nps } : {}),
    ...(info.nodes !== undefined ? { nodes: info.nodes } : {}),
    ...(info.time !== undefined ? { time: info.time } : {}),
  };
  const i = lines.findIndex((l) => l.multipv === info.multipv);
  if (i >= 0) {
    const next = lines.slice();
    next[i] = line;
    return next;
  }
  return [...lines, line].sort((a, b) => a.multipv - b.multipv);
}

/** Checkmate/stalemate detection for positions the engine should not search. */
export function classifyPosition(fen: string): TerminalKind | null {
  try {
    const c = new Chess(fen);
    if (c.isCheckmate()) return 'checkmate';
    if (c.isStalemate()) return 'stalemate';
  } catch {
    /* invalid FEN: let the engine report it */
  }
  return null;
}

function loadPersisted(): { enabled: boolean; settings: AnalysisSettings } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { enabled?: unknown; settings?: Partial<AnalysisSettings> };
      return { enabled: v.enabled === true, settings: sanitizeSettings(v.settings) };
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return { enabled: false, settings: { ...DEFAULT_SETTINGS } };
}

function persist(s: Pick<AnalysisState, 'enabled' | 'settings'>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: s.enabled, settings: s.settings }));
  } catch {
    /* storage unavailable; settings still apply for this session */
  }
}

let controller: AnalysisController | null = null;
/** Re-creates the engine through the current factory (set while a controller is running). */
let switchBackend: (() => void) | null = null;

/** Auto-reconnect bookkeeping of the remote backend (see {@link startAnalysisController}). */
const reconnect: {
  attempts: number;
  wasReady: boolean;
  timer: ReturnType<typeof setTimeout> | null;
} = {
  attempts: 0,
  wasReady: false,
  timer: null,
};

function resetReconnect(): void {
  if (reconnect.timer !== null) clearTimeout(reconnect.timer);
  reconnect.timer = null;
  reconnect.attempts = 0;
  reconnect.wasReady = false;
}

export const RECONNECT_MAX_ATTEMPTS = 3;
export const RECONNECT_BASE_MS = 1000;

/** Maps a remote load/search failure to a short user-facing message. */
export function describeRemoteError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'closed' || code === 'timeout') return 'Server unreachable';
  if (code === 'no_capacity') return 'Server busy, try again';
  return err instanceof Error ? err.message : String(err);
}

/** A remote engine as the store sees it: the analysis engine plus connection metadata. */
export interface RemoteLikeEngine extends AnalysisEngine {
  onStatus?(cb: (status: string, error?: string) => void): () => void;
  readonly limits?: Limits;
}

export const useAnalysisStore = create<AnalysisStore>()((set, get) => ({
  ...loadPersisted(),
  status: 'idle',
  fen: currentFen(useGameStore.getState()),
  terminal: null,
  lines: [],

  setEnabled: (enabled) => {
    // Disabling also clears a pending error; re-enabling retries with a fresh engine.
    set(
      enabled || get().status !== 'error'
        ? { enabled }
        : { enabled, status: 'idle', error: undefined },
    );
    persist(get());
    if (!enabled) resetReconnect();
    controller?.setEnabled(enabled);
  },

  setSettings: (patch) => {
    const prev = get().settings;
    const settings = sanitizeSettings(patch, prev);
    const switched = settings.backend !== prev.backend || settings.remoteUrl !== prev.remoteUrl;
    set(
      switched
        ? {
            settings,
            status: 'idle',
            error: undefined,
            engineName: undefined,
            capabilities: undefined,
            backendStatus: undefined,
            backendError: undefined,
            remoteLimits: undefined,
          }
        : { settings },
    );
    persist(get());
    controller?.setSettings(settings);
    if (switched) {
      resetReconnect();
      switchBackend?.();
    }
  },

  retry: () => {
    resetReconnect();
    controller?.retry();
  },

  analysePosition: (fen) => controller?.setPosition(fen),
}));

export interface StartAnalysisOptions {
  /**
   * Engine factory per backend; defaults to lazily imported {@link WasmEngineClient} /
   * {@link RemoteEngineClient}.
   */
  createEngine?: (
    backend: Backend,
    settings: AnalysisSettings,
  ) => RemoteLikeEngine | Promise<RemoteLikeEngine>;
  debounceMs?: number;
}

const createDefaultEngine = async (
  backend: Backend,
  settings: AnalysisSettings,
): Promise<RemoteLikeEngine> => {
  if (backend === 'remote') {
    const { RemoteEngineClient } = await import('../engine/RemoteEngineClient');
    return new RemoteEngineClient(settings.remoteUrl ? { url: settings.remoteUrl } : {});
  }
  const { WasmEngineClient } = await import('../engine/WasmEngineClient');
  return new WasmEngineClient();
};

/**
 * Connects the analysis store to the game store: while enabled, the engine follows the current
 * FEN (debounced). Returns a function that disconnects and disposes the engine.
 */
export function startAnalysisController(opts: StartAnalysisOptions = {}): () => void {
  controller?.dispose();
  const set = useAnalysisStore.setState;
  const get = useAnalysisStore.getState;
  const create = opts.createEngine ?? createDefaultEngine;
  /** The remote engine whose status is mirrored (events of older instances are ignored). */
  let remote: RemoteLikeEngine | null = null;

  const onRemoteStatus = (status: string, error?: string) => {
    if (
      status !== 'connecting' &&
      status !== 'ready' &&
      status !== 'closed' &&
      status !== 'error'
    ) {
      return;
    }
    const patch: Partial<AnalysisState> = { backendStatus: status };
    if (status === 'ready') {
      resetReconnect();
      reconnect.wasReady = true;
      patch.backendError = undefined;
      patch.remoteLimits = remote?.limits;
    } else if ((status === 'closed' || status === 'error') && reconnect.wasReady) {
      // Lost an established session (or a reconnect attempt failed): back off and retry.
      if (reconnect.attempts < RECONNECT_MAX_ATTEMPTS && get().enabled) {
        const delay = RECONNECT_BASE_MS * 2 ** reconnect.attempts++;
        if (reconnect.timer !== null) clearTimeout(reconnect.timer);
        reconnect.timer = setTimeout(() => {
          reconnect.timer = null;
          if (!get().enabled || get().settings.backend !== 'remote') return;
          c.release();
          c.resume();
        }, delay);
      }
      patch.backendError = 'Connection lost';
    } else if (status === 'error') {
      patch.backendError = error;
    }
    set(patch);
  };

  const makeEngine = async (): Promise<AnalysisEngine> => {
    const settings = get().settings;
    const engine = await create(settings.backend, settings);
    if (settings.backend !== 'remote') return engine;
    remote = engine;
    let released = false;
    const unsubscribe = engine.onStatus?.((status, error) => {
      if (!released && remote === engine) onRemoteStatus(status, error);
    });
    const dispose = engine.dispose.bind(engine);
    engine.dispose = () => {
      released = true;
      unsubscribe?.();
      return dispose();
    };
    const load = engine.load.bind(engine);
    engine.load = async () => {
      try {
        await load();
      } catch (err) {
        if (!released && remote === engine) {
          // During a reconnect the generic "Connection lost" stays.
          if (!reconnect.wasReady) set({ backendError: describeRemoteError(err) });
        }
        throw err;
      }
      if (!released && remote === engine) set({ remoteLimits: engine.limits });
    };
    return engine;
  };

  const c = new AnalysisController({
    createEngine: makeEngine,
    debounceMs: opts.debounceMs,
    classify: classifyPosition,
    settings: get().settings,
    callbacks: {
      onStatus: (status, error) => set({ status, error: status === 'error' ? error : undefined }),
      onEngine: ({ engineName, capabilities }) => set({ engineName, capabilities }),
      onReset: (fen, terminal) => set({ fen, terminal, lines: [], bestMove: undefined }),
      onInfo: (fen, info) => {
        const s = get();
        if (fen !== s.fen) return;
        const lines = mergeLine(s.lines, info, s.settings.multipv);
        if (lines !== s.lines) set({ lines });
      },
      onBestMove: (fen, move) => {
        if (fen === get().fen) set({ bestMove: move ?? undefined });
      },
    },
  });
  controller = c;
  switchBackend = () => c.setEngineFactory(makeEngine);
  c.setPosition(currentFen(useGameStore.getState()));
  const unsubscribe = useGameStore.subscribe((s) => c.setPosition(currentFen(s)));
  if (get().enabled) c.setEnabled(true);

  const onPageHide = () => c.release();
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) c.resume();
  };
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);

  return () => {
    unsubscribe();
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    c.dispose();
    resetReconnect();
    if (controller === c) {
      controller = null;
      switchBackend = null;
    }
  };
}
