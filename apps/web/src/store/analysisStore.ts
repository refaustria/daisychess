import type {
  AnalysisDeniedReason,
  EngineInfo,
  Limits,
  Score,
  WelcomeNode,
} from '@daisychess/engine-core';
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
import {
  canEnable,
  currentEnv,
  defaultWasmKey,
  displacedBy,
  isMultiThreadKey,
  MAX_REMOTE_ENGINES,
  maxWasmInstances,
  parseEngineKey,
  probeServer as runProbe,
  type EngineKey,
  type ParsedEngineKey,
  type ProbeClient,
  type RegistryEnv,
  type ServerProbeState,
} from '../engine/registry';
import { browserEnginePool } from '../engine/wasmPool';
import { allowWasmRetry, clearWasmNotice, subscribeWasmHealth, wasmHealth } from '../engine/wasmHealth';
import { currentFen, useGameStore } from './gameStore';
import { deniedMessage, isAuthError, UNAUTHORIZED_MESSAGE } from '../server/tokenMessages';
import { useSettingsStore } from './settingsStore';

export type { AnalysisStatus, EngineCapabilities, EngineKey, TerminalKind };

export type Backend = 'wasm' | 'remote';
export type BackendStatus = 'connecting' | 'ready' | 'closed' | 'error';

export interface AnalysisSettings extends ControllerSettings {
  /** WebSocket URL of the engine server (dev/e2e; default derived from the page host). Not shown in the UI. */
  remoteUrl?: string;
}

/** Fields an engine can override (ADR-010); the rest of {@link AnalysisSettings} is global. */
export type EngineSettingField = 'depth' | 'multipv' | 'threads';
export type EngineSettingsOverride = Partial<Pick<AnalysisSettings, EngineSettingField>>;
/** Patch for {@link AnalysisActions.setEngineSettings}: `null` removes the override of a field. */
export type EngineSettingsPatch = Partial<Record<EngineSettingField, number | null>>;
export const ENGINE_SETTING_FIELDS: readonly EngineSettingField[] = ['depth', 'multipv', 'threads'];

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

/** Live state of one enabled engine (one {@link AnalysisController} each). */
export interface EngineInstanceState {
  key: EngineKey;
  status: AnalysisStatus;
  error?: string;
  engineName?: string;
  capabilities?: EngineCapabilities;
  /** Sorted by `multipv` (1 = best line). */
  lines: AnalysisLine[];
  /** Engine's best move (UCI) once the search reached the depth limit. */
  bestMove?: string;
  /** Connection state of a server engine (undefined for browser engines). */
  backendStatus?: BackendStatus;
  /** User-facing reason for a remote failure ("Server unreachable", "Connection lost", ...). */
  backendError?: string;
  /** Limits announced by the server (after a successful connect). */
  remoteLimits?: Limits;
  /** Where the server engine runs (`welcome.node`, ADR-020); absent on a standalone server. */
  node?: WelcomeNode;
}

export interface AnalysisState {
  /** Master switch: all enabled engines analyse while true. */
  enabled: boolean;
  /** Engines selected for analysis (registry keys, ≥ 1, in tab order; the first is the primary). */
  enabledEngines: EngineKey[];
  /** Global defaults (and the server URL); each engine may override depth/MultiPV/threads. */
  settings: AnalysisSettings;
  /**
   * Per-engine overrides of {@link settings}, persisted per registry key (also for engines that are
   * currently disabled). Effective settings: {@link effectiveSettings}.
   */
  engineSettings: Record<EngineKey, EngineSettingsOverride>;
  /** Page capabilities used for labels, thread options and the resource guard (injectable for tests). */
  env: RegistryEnv;
  /** Position the lines belong to (follows the game store's current FEN). */
  fen: string;
  /** Set for checkmate/stalemate positions, which are not analysed (lines stay empty). */
  terminal: TerminalKind | null;
  /** One entry per key of `enabledEngines`. */
  instances: Record<EngineKey, EngineInstanceState>;
  /** Cached discovery of the server's engines (see {@link AnalysisActions.probeServer}). */
  serverProbe: ServerProbeState;
  /** Why the last attempt to enable an engine was refused (resource guard). */
  engineHint?: string;
  /** One-time notice of the browser engine's out-of-memory recovery (ADR-015). */
  wasmNotice?: string;
}

export interface AnalysisActions {
  /** Master switch for all enabled engines. */
  setEnabled(enabled: boolean): void;
  /** Updates the global defaults (engines without an override of a field follow them). */
  setSettings(settings: Partial<AnalysisSettings>): void;
  /** Overrides depth/MultiPV/threads for one engine; `null` falls back to the default again. */
  setEngineSettings(key: EngineKey, patch: EngineSettingsPatch): void;
  /** Makes `key`'s effective settings the defaults and removes every engine's override. */
  applySettingsToAll(key: EngineKey): void;
  /** Drops the probe cache and reconnects every server engine (server URL or access token changed). */
  reconnectServer(): void;
  /**
   * Adds or removes an engine. Refused (returns false, sets `engineHint`) when the resource guard
   * says no or when removing the last engine. A removed engine's worker/socket is disposed.
   * Enabling `wasm:lite` or `wasm:full` replaces the other one (in its tab position).
   */
  setEngineEnabled(key: EngineKey, on: boolean): boolean;
  /** Replaces the server engines by the default browser engine (error fallback). */
  fallBackToBrowser(): void;
  clearEngineHint(): void;
  dismissWasmNotice(): void;
  /** Re-creates failed engines (all, or only `key`); also re-allows a disabled browser engine. */
  retry(key?: EngineKey): void;
  /**
   * Discovers the server's engines (one short connection). Cached: a successful result is reused
   * for {@link PROBE_TTL_MS}, a failure for {@link PROBE_ERROR_TTL_MS}; `force` ignores the cache.
   */
  probeServer(opts?: { force?: boolean }): Promise<void>;
  /** Internal: feeds a position to the controllers (normally driven by {@link startAnalysisController}). */
  analysePosition(fen: string): void;
}

export type AnalysisStore = AnalysisState & AnalysisActions;

export const MAX_DEPTH = 40;
export const MAX_MULTIPV = 5;
export const DEFAULT_SETTINGS: AnalysisSettings = { depth: 22, multipv: 1 };
export const STORAGE_KEY = 'daisychess.analysis';
export const PROBE_TTL_MS = 60_000;
export const PROBE_ERROR_TTL_MS = 5_000;
/** Upper bound of `enabledEngines` (one multi- and one single-threaded browser build + the server engines). */
export const MAX_ENGINES = 2 + MAX_REMOTE_ENGINES;

const clampInt = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.round(v)))
    : fallback;

/**
 * Merges a partial update into `base`, clamping depth to 0..40 (0 = infinite) and MultiPV to 1..5.
 * Unknown fields (e.g. the legacy `backend`, see {@link migratePersisted}) are dropped.
 */
export function sanitizeSettings(
  patch: Partial<AnalysisSettings> | null | undefined,
  base: AnalysisSettings = DEFAULT_SETTINGS,
): AnalysisSettings {
  const p = patch ?? {};
  const out: AnalysisSettings = {
    depth: clampInt(p.depth, 0, MAX_DEPTH, base.depth),
    multipv: clampInt(p.multipv, 1, MAX_MULTIPV, base.multipv),
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
 * Valid, unique keys in order: a multi-threaded build (`wasm:lite`/`wasm:full`) that this page
 * cannot run becomes `wasm:lite-single`, only the first multi-threaded build is kept, browser
 * engines are capped by the memory budget, server engines at {@link MAX_REMOTE_ENGINES}; never
 * empty (default browser engine).
 */
export function sanitizeEngineKeys(keys: unknown, env: RegistryEnv = currentEnv()): EngineKey[] {
  const out: EngineKey[] = [];
  let remotes = 0;
  let wasm = 0;
  for (const raw of Array.isArray(keys) ? keys : []) {
    const parsed = parseEngineKey(raw);
    if (!parsed) continue;
    let key = raw as string;
    if (parsed.backend === 'wasm' && parsed.build !== 'lite-single' && !env.crossOriginIsolated) {
      key = 'wasm:lite-single';
    }
    if (out.includes(key)) continue;
    if (isMultiThreadKey(key) && out.some(isMultiThreadKey)) continue;
    if (parsed.backend === 'remote' && ++remotes > MAX_REMOTE_ENGINES) continue;
    if (parsed.backend === 'wasm' && ++wasm > maxWasmInstances(env)) continue;
    out.push(key);
    if (out.length >= MAX_ENGINES) break;
  }
  return out.length > 0 ? out : [defaultWasmKey(env)];
}

export interface PersistedAnalysis {
  enabled: boolean;
  enabledEngines: EngineKey[];
  settings: AnalysisSettings;
  /** Omitted when no engine has an override (the pre-ADR-010 shape). */
  engineSettings?: Record<EngineKey, EngineSettingsOverride>;
}

/** Clamps one override like {@link sanitizeSettings}; unknown fields and non-numbers are dropped. */
export function sanitizeOverride(raw: unknown): EngineSettingsOverride {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: EngineSettingsOverride = {};
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (num(o.depth)) out.depth = clampInt(o.depth, 0, MAX_DEPTH, 0);
  if (num(o.multipv)) out.multipv = clampInt(o.multipv, 1, MAX_MULTIPV, 1);
  if (num(o.threads)) out.threads = clampInt(o.threads, 1, 1024, 1);
  return out;
}

/** Valid registry keys with a non-empty override (at most 16 entries). */
export function sanitizeEngineSettings(raw: unknown): Record<EngineKey, EngineSettingsOverride> {
  const out: Record<EngineKey, EngineSettingsOverride> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!parseEngineKey(key)) continue;
    const o = sanitizeOverride(value);
    if (Object.keys(o).length > 0) out[key] = o;
    if (Object.keys(out).length >= 16) break;
  }
  return out;
}

/** Defaults merged with the engine's override (what its controller runs with). */
export function effectiveSettings(
  s: Pick<AnalysisState, 'settings' | 'engineSettings'>,
  key: EngineKey,
): AnalysisSettings {
  const o = s.engineSettings[key];
  return o ? { ...s.settings, ...o } : s.settings;
}

/**
 * Reads the persisted shape, migrating the single-engine format (`settings.backend`, before M5):
 * `backend: 'remote'` → `['remote:stockfish']`, `'wasm'`/missing → the default browser engine.
 */
export function migratePersisted(raw: unknown, env: RegistryEnv = currentEnv()): PersistedAnalysis {
  const v = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    enabled?: unknown;
    enabledEngines?: unknown;
    settings?: (Partial<AnalysisSettings> & { backend?: unknown }) | null;
    engineSettings?: unknown;
  };
  const settings = sanitizeSettings(
    typeof v.settings === 'object' && v.settings !== null ? v.settings : undefined,
  );
  const legacy = v.settings?.backend === 'remote' ? ['remote:stockfish'] : [];
  const engineSettings = sanitizeEngineSettings(v.engineSettings);
  return {
    enabled: v.enabled === true,
    enabledEngines: sanitizeEngineKeys(
      Array.isArray(v.enabledEngines) ? v.enabledEngines : legacy,
      env,
    ),
    settings,
    ...(Object.keys(engineSettings).length > 0 ? { engineSettings } : {}),
  };
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

function loadPersisted(): PersistedAnalysis {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migratePersisted(JSON.parse(raw));
  } catch {
    /* storage unavailable or corrupt */
  }
  return migratePersisted(null);
}

function persist(s: PersistedAnalysis): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        enabled: s.enabled,
        enabledEngines: s.enabledEngines,
        settings: s.settings,
        ...(s.engineSettings && Object.keys(s.engineSettings).length > 0
          ? { engineSettings: s.engineSettings }
          : {}),
      }),
    );
  } catch {
    /* storage unavailable; settings still apply for this session */
  }
}

export const newInstance = (key: EngineKey): EngineInstanceState => ({
  key,
  status: 'idle',
  lines: [],
});

const instancesFor = (
  keys: readonly EngineKey[],
  prev: Record<EngineKey, EngineInstanceState> = {},
): Record<EngineKey, EngineInstanceState> =>
  Object.fromEntries(keys.map((k) => [k, prev[k] ?? newInstance(k)]));

const IDLE_INSTANCE: EngineInstanceState = Object.freeze({
  key: '',
  status: 'idle' as const,
  lines: [] as AnalysisLine[],
});

/** The first enabled engine: drives the eval bar, the best-move arrow and the engine toggle. */
export function selectPrimary(
  s: Pick<AnalysisState, 'enabledEngines' | 'instances'>,
): EngineInstanceState {
  const key = s.enabledEngines[0];
  return (key !== undefined ? s.instances[key] : undefined) ?? IDLE_INSTANCE;
}

export const isRemoteKey = (key: EngineKey | undefined): boolean =>
  key !== undefined && key.startsWith('remote:');

export const RECONNECT_MAX_ATTEMPTS = 3;
export const RECONNECT_BASE_MS = 1000;

/** Shown when the server requires an access token and none or a wrong one was sent (ADR-010). */
export { UNAUTHORIZED_MESSAGE, isAuthError };

/** Maps a remote load/search failure to a short user-facing message. */
export function describeRemoteError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'closed' || code === 'timeout') return 'Server unreachable';
  if (code === 'no_capacity') return 'Server busy, try again';
  if (code === 'unauthorized') return UNAUTHORIZED_MESSAGE;
  if (code === 'denied') {
    const reason = (err as { deniedReason?: AnalysisDeniedReason }).deniedReason;
    return deniedMessage(reason);
  }
  if (code === 'node_lost') return 'Engine node lost';
  if (code === 'unknown_engine') return err instanceof Error ? err.message : 'Unknown engine';
  return err instanceof Error ? err.message : String(err);
}

/** A remote engine as the store sees it: the analysis engine plus connection metadata. */
export interface RemoteLikeEngine extends AnalysisEngine {
  onStatus?(cb: (status: string, error?: string) => void): () => void;
  readonly limits?: Limits;
  readonly node?: WelcomeNode;
  /** Code of the last connection loss (`node_lost`: close code 1012). */
  readonly lastCode?: string;
}

/** What {@link startAnalysisController} installs so the store actions reach the controllers. */
interface ControllerBridge {
  sync(): void;
  setEnabled(enabled: boolean): void;
  /** Pushes the effective settings to every controller (defaults or an override changed). */
  applySettings(): void;
  /** Recreates the server engines (new URL or token). */
  reconnectRemote(): void;
  retry(key?: EngineKey): void;
  setPosition(fen: string): void;
}

let bridge: ControllerBridge | null = null;
/** Stops the running {@link startAnalysisController} (only one may run). */
let stopActive: (() => void) | null = null;

export type ProbeClientFactory = (settings: AnalysisSettings) => ProbeClient | Promise<ProbeClient>;

/** The access token from the Settings tab (sent in `hello.token`; ADR-010). */
const serverToken = (): string | undefined => useSettingsStore.getState().serverToken || undefined;

const defaultProbeClient: ProbeClientFactory = async (settings) => {
  const { RemoteEngineClient } = await import('../engine/RemoteEngineClient');
  const token = serverToken();
  return new RemoteEngineClient({
    ...(settings.remoteUrl ? { url: settings.remoteUrl } : {}),
    ...(token ? { token } : {}),
    handshakeTimeoutMs: 5_000,
    clientInfo: { name: 'daisychess-web-probe' },
  });
};

let probeClient: ProbeClientFactory = defaultProbeClient;
let probePromise: Promise<void> | null = null;
/** Bumped when the server URL changes, so an outdated probe result is dropped. */
let probeGen = 0;

export const useAnalysisStore = create<AnalysisStore>()((set, get) => {
  const initial = loadPersisted();
  const save = () => persist(get());
  const settingsChanged = () => {
    save();
    bridge?.applySettings();
  };

  const replaceEngines = (keys: EngineKey[]) => {
    set((s) => ({ enabledEngines: keys, instances: instancesFor(keys, s.instances) }));
    save();
    bridge?.sync();
  };

  return {
    ...initial,
    engineSettings: initial.engineSettings ?? {},
    env: currentEnv(),
    instances: instancesFor(initial.enabledEngines),
    fen: currentFen(useGameStore.getState()),
    terminal: null,
    serverProbe: { status: 'idle' },
    ...(wasmHealth().notice ? { wasmNotice: wasmHealth().notice } : {}),

    setEnabled: (enabled) => {
      // Disabling also clears pending errors; re-enabling retries with fresh engines.
      set((s) => ({
        enabled,
        instances: enabled
          ? s.instances
          : Object.fromEntries(
              Object.entries(s.instances).map(([k, i]) => [
                k,
                i.status === 'error' ? { ...i, status: 'idle' as const, error: undefined } : i,
              ]),
            ),
      }));
      save();
      bridge?.setEnabled(enabled);
    },

    setSettings: (patch) => {
      const prev = get().settings;
      const settings = sanitizeSettings(patch, prev);
      set({ settings });
      settingsChanged();
      if (settings.remoteUrl !== prev.remoteUrl) get().reconnectServer();
    },

    setEngineSettings: (key, patch) => {
      if (!parseEngineKey(key)) return;
      const current = get().engineSettings[key] ?? {};
      const merged: Record<string, number> = { ...current };
      for (const f of ENGINE_SETTING_FIELDS) {
        const v = patch[f];
        if (v === null) delete merged[f];
        else if (v !== undefined) merged[f] = v;
      }
      const next = sanitizeOverride(merged);
      const all = { ...get().engineSettings };
      if (Object.keys(next).length > 0) all[key] = next;
      else delete all[key];
      set({ engineSettings: all });
      settingsChanged();
    },

    applySettingsToAll: (key) => {
      const eff = effectiveSettings(get(), key);
      const settings = sanitizeSettings(
        { depth: eff.depth, multipv: eff.multipv, threads: eff.threads },
        get().settings,
      );
      if (eff.threads === undefined) delete settings.threads;
      set({ settings, engineSettings: {} });
      settingsChanged();
    },

    reconnectServer: () => {
      probeGen++;
      probePromise = null;
      set((s) => ({
        serverProbe: { status: 'idle' },
        instances: Object.fromEntries(
          Object.entries(s.instances).map(([k, i]) => [k, isRemoteKey(k) ? newInstance(k) : i]),
        ),
      }));
      bridge?.reconnectRemote();
      if (get().enabledEngines.some(isRemoteKey)) void get().probeServer();
    },

    setEngineEnabled: (key, on) => {
      const keys = get().enabledEngines;
      if (!on) {
        if (!keys.includes(key)) return true;
        if (keys.length === 1) {
          set({
            engineHint:
              'At least one engine stays selected; use the Engine switch to stop analysis',
          });
          return false;
        }
        set({ engineHint: undefined });
        replaceEngines(keys.filter((k) => k !== key));
        return true;
      }
      if (keys.includes(key)) return true;
      const displaced = displacedBy(key, keys);
      const guard =
        keys.length - displaced.length >= MAX_ENGINES
          ? { ok: false as const, reason: `At most ${MAX_ENGINES} engines can run at once` }
          : canEnable(
              key,
              keys.filter((k) => !displaced.includes(k)),
              get().env,
            );
      if (!guard.ok) {
        set({ engineHint: guard.reason });
        return false;
      }
      if (displaced.length > 0) {
        // One multi-threaded browser engine at a time: take the replaced one's tab position.
        let placed = false;
        const next: EngineKey[] = [];
        for (const k of keys) {
          if (!displaced.includes(k)) next.push(k);
          else if (!placed) {
            next.push(key);
            placed = true;
          }
        }
        set({
          engineHint:
            'Only one multi-threaded browser engine runs at a time; it replaced the other one',
        });
        replaceEngines(next);
        return true;
      }
      set({ engineHint: undefined });
      replaceEngines([...keys, key]);
      if (isRemoteKey(key)) void get().probeServer();
      return true;
    },

    fallBackToBrowser: () => {
      const browser = get().enabledEngines.filter((k) => !isRemoteKey(k));
      replaceEngines(browser.length > 0 ? browser : [defaultWasmKey(get().env)]);
    },

    clearEngineHint: () => set({ engineHint: undefined }),

    dismissWasmNotice: () => {
      clearWasmNotice();
      set({ wasmNotice: undefined });
    },

    retry: (key) => {
      if (key === undefined || !isRemoteKey(key)) allowWasmRetry();
      bridge?.retry(key);
    },

    probeServer: (opts = {}) => {
      if (probePromise) return probePromise;
      const p = get().serverProbe;
      const age = p.lastProbe !== undefined ? Date.now() - p.lastProbe : Infinity;
      if (!opts.force) {
        if (p.status === 'ok' && age < PROBE_TTL_MS) return Promise.resolve();
        if (p.status === 'error' && age < PROBE_ERROR_TTL_MS) return Promise.resolve();
      }
      const gen = probeGen;
      const settings = get().settings;
      set({ serverProbe: { ...p, status: 'probing', error: undefined } });
      const run = (async () => {
        try {
          const result = await runProbe(() => probeClient(settings));
          if (gen !== probeGen) return;
          set({
            serverProbe: {
              status: 'ok',
              engines: result.engines,
              ...(result.limits ? { limits: result.limits } : {}),
              ...(result.node ? { node: result.node } : {}),
              lastProbe: Date.now(),
            },
          });
        } catch (err) {
          if (gen !== probeGen) return;
          set({
            serverProbe: {
              status: 'error',
              error: describeRemoteError(err),
              lastProbe: Date.now(),
            },
          });
        }
      })().finally(() => {
        if (probePromise === run) probePromise = null;
      });
      probePromise = run;
      return run;
    },

    analysePosition: (fen) => {
      if (fen !== get().fen) set({ fen, terminal: classifyPosition(fen) });
      bridge?.setPosition(fen);
    },
  };
});

// The browser engine's out-of-memory notice (set once per session by the engine code).
subscribeWasmHealth((h) => {
  if (h.notice !== useAnalysisStore.getState().wasmNotice) useAnalysisStore.setState({ wasmNotice: h.notice });
});

/** Primary (first enabled) engine's state; a stable reference between its updates. */
export function usePrimaryAnalysis(): EngineInstanceState {
  return useAnalysisStore(selectPrimary);
}

/** Identifies the engine to create: its registry key plus the parsed key. */
export type EngineSpec = ParsedEngineKey & { key: EngineKey };

export interface StartAnalysisOptions {
  /**
   * Engine factory per registry key; defaults to lazily imported {@link WasmEngineClient}
   * (`build` from the key) / {@link RemoteEngineClient} (`engineId` from the key).
   */
  createEngine?: (
    spec: EngineSpec,
    settings: AnalysisSettings,
  ) => RemoteLikeEngine | Promise<RemoteLikeEngine>;
  /** Client used by `probeServer`; defaults to a {@link RemoteEngineClient}. */
  createProbeClient?: ProbeClientFactory;
  debounceMs?: number;
}

const createDefaultEngine = async (
  spec: EngineSpec,
  settings: AnalysisSettings,
): Promise<RemoteLikeEngine> => {
  if (spec.backend === 'remote') {
    const { RemoteEngineClient } = await import('../engine/RemoteEngineClient');
    const token = serverToken();
    return new RemoteEngineClient({
      ...(settings.remoteUrl ? { url: settings.remoteUrl } : {}),
      ...(token ? { token } : {}),
      engineId: spec.engineId,
    });
  }
  const { WasmEngineClient } = await import('../engine/WasmEngineClient');
  return new WasmEngineClient({ build: spec.build });
};

interface Runner {
  key: EngineKey;
  spec: EngineSpec;
  controller: AnalysisController;
  /** The remote engine whose status is mirrored (events of older instances are ignored). */
  remote: RemoteLikeEngine | null;
  /** Auto-reconnect bookkeeping (server engines). */
  reconnect: { attempts: number; wasReady: boolean;
    /** The one immediate reconnect after a node loss (close 1012) was used. */
    nodeLostRetried: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  };
  makeEngine(): Promise<AnalysisEngine>;
}

function resetReconnect(r: Runner): void {
  if (r.reconnect.timer !== null) clearTimeout(r.reconnect.timer);
  r.reconnect.timer = null;
  r.reconnect.attempts = 0;
  r.reconnect.wasReady = false;
  r.reconnect.nodeLostRetried = false;
}

/**
 * Connects the analysis store to the game store: one {@link AnalysisController} per enabled
 * engine, all following the current FEN (debounced) while the master switch is on. Disabling an
 * engine disposes its controller (and with it the worker/socket). Returns a function that
 * disconnects and disposes everything.
 */
export function startAnalysisController(opts: StartAnalysisOptions = {}): () => void {
  stopActive?.();
  const set = useAnalysisStore.setState;
  const get = useAnalysisStore.getState;
  const create = opts.createEngine ?? createDefaultEngine;
  const runners = new Map<EngineKey, Runner>();
  let disposed = false;
  if (opts.createProbeClient) probeClient = opts.createProbeClient;

  /** Patches the instance of `r` unless `r` was removed (late events of a disposed engine). */
  const patch = (
    r: Runner,
    p:
      | Partial<EngineInstanceState>
      | ((i: EngineInstanceState) => Partial<EngineInstanceState> | null),
  ) => {
    if (runners.get(r.key) !== r) return;
    const inst = get().instances[r.key];
    if (!inst) return;
    const next = typeof p === 'function' ? p(inst) : p;
    if (!next) return;
    set({ instances: { ...get().instances, [r.key]: { ...inst, ...next } } });
  };

  const createRunner = (key: EngineKey, spec: EngineSpec): Runner => {
    const runner: Omit<Runner, 'controller'> = {
      key,
      spec,
      remote: null,
      reconnect: { attempts: 0, wasReady: false, nodeLostRetried: false, timer: null },
      makeEngine: async () => {
        const engine = await create(spec, effectiveSettings(get(), key));
        if (spec.backend !== 'remote') return engine;
        runner.remote = engine;
        let released = false;
        const current = () => !released && r.remote === engine && runners.get(key) === r;
        const unsubscribe = engine.onStatus?.((status, error) => {
          if (current()) onRemoteStatus(status, error);
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
            // During a reconnect the generic "Connection lost" stays.
            if (current() && !r.reconnect.wasReady)
              patch(r, { backendError: describeRemoteError(err) });
            throw err;
          }
          if (current()) patch(r, { remoteLimits: engine.limits, node: engine.node });
        };
        return engine;
      },
    };

    const onRemoteStatus = (status: string, error?: string) => {
      if (
        status !== 'connecting' &&
        status !== 'ready' &&
        status !== 'closed' &&
        status !== 'error'
      ) {
        return;
      }
      const p: Partial<EngineInstanceState> = { backendStatus: status };
      if (status === 'ready') {
        resetReconnect(r);
        r.reconnect.wasReady = true;
        p.backendError = undefined;
        p.remoteLimits = r.remote?.limits;
        p.node = r.remote?.node;
      } else if ((status === 'closed' || status === 'error') && r.reconnect.wasReady) {
        // Lost an established session (or a reconnect attempt failed): back off and retry.
        // Node lost (close 1012): the hub routes a fresh `hello` to another node, so reconnect
        // at once (one attempt) and re-probe where the engines run now.
        const nodeLost = r.remote?.lastCode === 'node_lost' && !r.reconnect.nodeLostRetried;
        if (nodeLost) {
          r.reconnect.nodeLostRetried = true;
          void get().probeServer({ force: true });
        }
        if (r.reconnect.attempts < RECONNECT_MAX_ATTEMPTS && get().enabled) {
          const delay = nodeLost ? 0 : RECONNECT_BASE_MS * 2 ** r.reconnect.attempts++;
          if (r.reconnect.timer !== null) clearTimeout(r.reconnect.timer);
          r.reconnect.timer = setTimeout(() => {
            r.reconnect.timer = null;
            if (!get().enabled || runners.get(key) !== r) return;
            r.controller.release();
            r.controller.resume();
          }, delay);
        }
        p.backendError = 'Connection lost';
      } else if (status === 'error') {
        p.backendError = error;
      }
      patch(r, p);
    };

    const controller = new AnalysisController({
      createEngine: () => r.makeEngine(),
      debounceMs: opts.debounceMs,
      classify: classifyPosition,
      settings: effectiveSettings(get(), key),
      callbacks: {
        onStatus: (status, error) =>
          patch(r, { status, error: status === 'error' ? error : undefined }),
        onEngine: ({ engineName, capabilities }) => patch(r, { engineName, capabilities }),
        onReset: () =>
          patch(r, (i) =>
            i.lines.length === 0 && i.bestMove === undefined
              ? null
              : { lines: [], bestMove: undefined },
          ),
        onInfo: (fen, info) => {
          if (fen !== get().fen) return;
          const multipv = effectiveSettings(get(), key).multipv;
          patch(r, (i) => {
            const lines = mergeLine(i.lines, info, multipv);
            return lines === i.lines ? null : { lines };
          });
        },
        onBestMove: (fen, move) => {
          if (fen === get().fen) patch(r, { bestMove: move ?? undefined });
        },
      },
    });
    const r: Runner = Object.assign(runner, { controller });
    return r;
  };

  const disposeRunner = (r: Runner) => {
    runners.delete(r.key);
    resetReconnect(r);
    r.controller.dispose();
  };

  const sync = () => {
    if (disposed) return;
    const s = get();
    const wanted = new Set(s.enabledEngines);
    for (const r of [...runners.values()]) if (!wanted.has(r.key)) disposeRunner(r);
    for (const key of s.enabledEngines) {
      if (runners.has(key)) continue;
      const parsed = parseEngineKey(key);
      if (!parsed) continue;
      const r = createRunner(key, { ...parsed, key });
      runners.set(key, r);
      if (!s.instances[key]) set({ instances: { ...get().instances, [key]: newInstance(key) } });
      r.controller.setPosition(get().fen);
      if (get().enabled) r.controller.setEnabled(true);
    }
  };

  const own: ControllerBridge = {
    sync,
    setEnabled: (enabled) => {
      const constrained = get().env.budget?.constrained === true;
      // Memory-constrained devices (ADR-015): the shared batch engine of the review/drill/game
      // goes away before the live engine loads again, and a paused live browser engine is
      // released (reloaded lazily on resume), so only one WASM instance is alive at a time.
      if (enabled && constrained) void browserEnginePool.trim();
      for (const r of runners.values()) {
        if (!enabled) resetReconnect(r);
        r.controller.setEnabled(enabled);
        if (!enabled && constrained && r.spec.backend === 'wasm') r.controller.release();
      }
    },
    applySettings: () => {
      for (const r of runners.values()) r.controller.setSettings(effectiveSettings(get(), r.key));
    },
    reconnectRemote: () => {
      for (const r of runners.values()) {
        if (r.spec.backend !== 'remote') continue;
        resetReconnect(r);
        r.controller.setEngineFactory(() => r.makeEngine());
      }
    },
    retry: (key) => {
      for (const r of runners.values()) {
        if (key !== undefined && r.key !== key) continue;
        resetReconnect(r);
        r.controller.retry();
      }
    },
    setPosition: (fen) => {
      for (const r of runners.values()) r.controller.setPosition(fen);
    },
  };
  bridge = own;

  const fen0 = currentFen(useGameStore.getState());
  set({ fen: fen0, terminal: classifyPosition(fen0) });
  sync();
  if (get().enabledEngines.some(isRemoteKey)) void get().probeServer();

  // A new access token (Settings tab) reconnects the server engines with it.
  const unsubscribeToken = useSettingsStore.subscribe((s, prev) => {
    if (s.serverToken !== prev.serverToken) get().reconnectServer();
  });

  let lastFen = fen0;
  const unsubscribe = useGameStore.subscribe((g) => {
    const fen = currentFen(g);
    if (fen === lastFen) return;
    lastFen = fen;
    get().analysePosition(fen);
  });

  const onPageHide = () => {
    for (const r of runners.values()) r.controller.release();
  };
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) for (const r of runners.values()) r.controller.resume();
  };
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);

  const stop = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    unsubscribeToken();
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    for (const r of [...runners.values()]) disposeRunner(r);
    if (bridge === own) bridge = null;
    if (stopActive === stop) stopActive = null;
    if (opts.createProbeClient && probeClient === opts.createProbeClient) {
      probeClient = defaultProbeClient;
    }
  };
  stopActive = stop;
  return stop;
}
