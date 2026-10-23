import type { EngineInfo, Score } from '@chesslab/engine-core';
import { Chess } from 'chess.js';
import { create } from 'zustand';
import {
  AnalysisController,
  type AnalysisEngine,
  type AnalysisSettings,
  type AnalysisStatus,
  type EngineCapabilities,
  type TerminalKind,
} from '../engine/AnalysisController';
import { currentFen, useGameStore } from './gameStore';

export type { AnalysisSettings, AnalysisStatus, EngineCapabilities, TerminalKind };

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
export const DEFAULT_SETTINGS: AnalysisSettings = { depth: 22, multipv: 1 };
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
  };
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
    controller?.setEnabled(enabled);
  },

  setSettings: (patch) => {
    const settings = sanitizeSettings(patch, get().settings);
    set({ settings });
    persist(get());
    controller?.setSettings(settings);
  },

  retry: () => controller?.retry(),

  analysePosition: (fen) => controller?.setPosition(fen),
}));

export interface StartAnalysisOptions {
  /** Engine factory; defaults to a lazily imported {@link WasmEngineClient}. */
  createEngine?: () => AnalysisEngine | Promise<AnalysisEngine>;
  debounceMs?: number;
}

const createWasmEngine = async (): Promise<AnalysisEngine> => {
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
  const c = new AnalysisController({
    createEngine: opts.createEngine ?? createWasmEngine,
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
    if (controller === c) controller = null;
  };
}
