import type { EngineDescriptor as ServerEngine, Limits } from '@chesslab/engine-core';
import type { WasmBuild } from './WasmEngineClient';

/**
 * Engine registry of the browser: which engines the user can enable for live analysis.
 *
 * Keys: `wasm:lite` (multi-threaded WASM, needs cross-origin isolation), `wasm:lite-single`
 * (single-threaded WASM, works everywhere), `wasm:full` (multi-threaded with the full-strength
 * network, ~99 MB download, opt-in; ADR-010) and `remote:<engineId>` (an engine of the ChessLab
 * server, discovered with {@link probeServer}).
 */
export type EngineKey = string;
export type EngineBackend = 'wasm' | 'remote';

export interface EngineDescriptor {
  key: EngineKey;
  backend: EngineBackend;
  /** Picker label, e.g. "Stockfish 19 (browser, multi-thread, 4 threads)". */
  name: string;
  /** Short label for tabs / the compare strip, e.g. "SF19". */
  short: string;
  /** Location badge, e.g. "browser", "browser 1T", "browser max", "server". */
  badge: string;
  available: boolean;
  /** Why the engine cannot be enabled (when `available` is false). */
  reason?: string;
  /** Approximate download in bytes when it is large enough to ask first (the full build). */
  downloadBytes?: number;
}

export type ParsedEngineKey =
  { backend: 'wasm'; build: WasmBuild } | { backend: 'remote'; engineId: string };

export interface RegistryEnv {
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
}

/** Server discovery result, cached by the analysis store. */
export interface ServerProbeState {
  status: 'idle' | 'probing' | 'ok' | 'error';
  engines?: readonly ServerEngine[];
  limits?: Limits;
  error?: string;
  /** `Date.now()` of the last finished probe (success or failure). */
  lastProbe?: number;
}

/** At most this many server engines run at once (each holds a connection and a server session). */
export const MAX_REMOTE_ENGINES = 2;
export const NOT_ISOLATED_REASON = 'Needs a cross-origin isolated page (COOP/COEP headers)';

const REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function parseEngineKey(key: unknown): ParsedEngineKey | null {
  if (key === 'wasm:lite') return { backend: 'wasm', build: 'lite' };
  if (key === 'wasm:lite-single') return { backend: 'wasm', build: 'lite-single' };
  if (key === 'wasm:full') return { backend: 'wasm', build: 'full' };
  if (typeof key === 'string' && key.startsWith('remote:')) {
    const engineId = key.slice('remote:'.length);
    if (REMOTE_ID.test(engineId)) return { backend: 'remote', engineId };
  }
  return null;
}

export function remoteKey(engineId: string): EngineKey {
  return `remote:${engineId}`;
}

/** Multi-threaded browser builds: they need cross-origin isolation and only one runs at a time. */
export const MULTI_THREAD_KEYS: readonly EngineKey[] = ['wasm:lite', 'wasm:full'];

export const isMultiThreadKey = (key: EngineKey): boolean => MULTI_THREAD_KEYS.includes(key);

/**
 * Keys that enabling `key` replaces: `wasm:lite` and `wasm:full` are mutually exclusive (each
 * spawns one worker per thread and they would compete for the same cores).
 */
export function displacedBy(key: EngineKey, enabled: readonly EngineKey[]): EngineKey[] {
  if (!isMultiThreadKey(key)) return [];
  return enabled.filter((k) => k !== key && isMultiThreadKey(k));
}

export function currentEnv(): RegistryEnv {
  return {
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    hardwareConcurrency: globalThis.navigator?.hardwareConcurrency || 1,
  };
}

/** The browser engine used by default: multi-threaded when the page allows it. */
export function defaultWasmKey(env: RegistryEnv = currentEnv()): EngineKey {
  return env.crossOriginIsolated ? 'wasm:lite' : 'wasm:lite-single';
}

function stockfishMajor(): string {
  const v = typeof __STOCKFISH_ENGINE__ !== 'undefined' ? __STOCKFISH_ENGINE__.version : '';
  return /^\d+/.exec(v)?.[0] ?? '';
}

/** "Stockfish 19" → "SF19"; other names are cut to their first word (max 10 chars). */
export function shortEngineName(name: string): string {
  const sf = /^Stockfish\s+(\d+)/i.exec(name);
  if (sf) return `SF${sf[1]}`;
  if (/^Fairy-Stockfish/i.test(name)) return 'Fairy-SF';
  return (name.split(/\s+/)[0] ?? name).slice(0, 10) || 'Engine';
}

/** Download size of the full build in bytes (0 when unknown, e.g. outside Vite). */
export function fullBuildBytes(): number {
  return typeof __STOCKFISH_ENGINE__ !== 'undefined' ? __STOCKFISH_ENGINE__.sizes.full : 0;
}

/** "~99 MB" (decimal megabytes, as download sizes are usually shown). */
export function formatDownload(bytes: number): string {
  return `~${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Default thread count of the multi-threaded builds: `min(cores - 1, 4)`, at least 1. */
export function defaultThreads(env: RegistryEnv): number {
  // Same rule as `selectBuild` in WasmEngineClient (not imported: that module is loaded lazily).
  const cores = Number.isFinite(env.hardwareConcurrency) ? Math.floor(env.hardwareConcurrency) : 1;
  return Math.max(1, Math.min(cores - 1, 4));
}

/**
 * The browser builds (static). `lite` and `full` are available only on cross-origin isolated
 * pages. Labels are unique on every machine (also when the multi-threaded build gets 1 thread).
 */
export function browserEngines(env: RegistryEnv = currentEnv()): EngineDescriptor[] {
  const major = stockfishMajor();
  const sf = major ? `Stockfish ${major}` : 'Stockfish';
  const threads = defaultThreads(env);
  const short = shortEngineName(sf);
  const isolated = env.crossOriginIsolated;
  const notIsolated = isolated ? {} : { reason: NOT_ISOLATED_REASON };
  const fullBytes = fullBuildBytes();
  return [
    {
      key: 'wasm:lite',
      backend: 'wasm',
      name: `${sf} (browser, multi-thread, ${threads} thread${threads === 1 ? '' : 's'})`,
      short,
      badge: 'browser',
      available: isolated,
      ...notIsolated,
    },
    {
      key: 'wasm:lite-single',
      backend: 'wasm',
      name: `${sf} (browser, single-thread)`,
      short,
      badge: isolated ? 'browser 1T' : 'browser',
      available: true,
    },
    {
      key: 'wasm:full',
      backend: 'wasm',
      name: `${sf} (browser, maximum strength${fullBytes > 0 ? `, ${formatDownload(fullBytes)} download` : ''})`,
      short,
      badge: 'browser max',
      available: isolated,
      ...notIsolated,
      ...(fullBytes > 0 ? { downloadBytes: fullBytes } : {}),
    },
  ];
}

/**
 * Server engines from the last probe. Keys that are enabled but unknown to the probe (not probed
 * yet, server down, engine removed) are listed too, so they stay visible and can be disabled.
 */
export function serverEngines(
  probe: ServerProbeState,
  enabledKeys: readonly EngineKey[] = [],
): EngineDescriptor[] {
  const out: EngineDescriptor[] = [];
  const seen = new Set<string>();
  for (const e of probe.status === 'ok' ? (probe.engines ?? []) : []) {
    const key = remoteKey(e.id);
    if (seen.has(key) || !parseEngineKey(key)) continue;
    seen.add(key);
    out.push({
      key,
      backend: 'remote',
      name: `${e.name} (server)`,
      short: shortEngineName(e.name),
      badge: 'server',
      available: e.enabled,
      ...(e.enabled ? {} : { reason: 'Disabled on the server' }),
    });
  }
  const reason =
    probe.status === 'probing' || probe.status === 'idle'
      ? 'Checking the server…'
      : probe.status === 'error'
        ? `Server unavailable: ${probe.error ?? 'unknown error'}`
        : 'Not offered by the server';
  const wanted = enabledKeys.filter((k) => k.startsWith('remote:'));
  // Before the first answer, offer the default server engine as a placeholder.
  if (probe.status !== 'ok' && wanted.length === 0) wanted.push(remoteKey('stockfish'));
  for (const key of wanted) {
    const parsed = parseEngineKey(key);
    if (!parsed || parsed.backend !== 'remote' || seen.has(key)) continue;
    seen.add(key);
    const name = parsed.engineId === 'stockfish' ? 'Stockfish' : parsed.engineId;
    out.push({
      key,
      backend: 'remote',
      name: `${name} (server)`,
      short: shortEngineName(name),
      badge: 'server',
      available: false,
      reason,
    });
  }
  return out;
}

/** All engines for the picker: browser builds first, then the server's engines. */
export function listEngines(
  probe: ServerProbeState,
  enabledKeys: readonly EngineKey[] = [],
  env: RegistryEnv = currentEnv(),
): EngineDescriptor[] {
  return [...browserEngines(env), ...serverEngines(probe, enabledKeys)];
}

/**
 * Descriptor for an enabled key (for tab labels); falls back to a generic entry for keys the
 * registry does not list (e.g. a server engine before the probe answered).
 */
export function describeEngine(
  key: EngineKey,
  probe: ServerProbeState,
  env: RegistryEnv = currentEnv(),
): EngineDescriptor {
  const found = listEngines(probe, [key], env).find((d) => d.key === key);
  if (found) return found;
  return { key, backend: 'wasm', name: key, short: key, badge: '', available: false };
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/**
 * Resource guard for enabling `key` next to `enabled`: unknown keys and unavailable browser builds
 * are refused, and at most {@link MAX_REMOTE_ENGINES} server engines run at once. Keys are unique,
 * and `wasm:lite`/`wasm:full` replace each other ({@link displacedBy}), so there is never more
 * than one multi-threaded and one single-threaded WASM instance.
 */
export function canEnable(
  key: EngineKey,
  enabled: readonly EngineKey[],
  env: RegistryEnv = currentEnv(),
): GuardResult {
  const parsed = parseEngineKey(key);
  if (!parsed) return { ok: false, reason: `Unknown engine "${String(key)}"` };
  if (enabled.includes(key)) return { ok: false, reason: 'Engine is already running' };
  if (parsed.backend === 'wasm') {
    if (parsed.build !== 'lite-single' && !env.crossOriginIsolated) {
      return { ok: false, reason: NOT_ISOLATED_REASON };
    }
    return { ok: true };
  }
  const remotes = enabled.filter((k) => k.startsWith('remote:')).length;
  if (remotes >= MAX_REMOTE_ENGINES) {
    return {
      ok: false,
      reason: `At most ${MAX_REMOTE_ENGINES} server engines can run at once`,
    };
  }
  return { ok: true };
}

/** What {@link probeServer} needs from a client (a {@link RemoteEngineClient} in production). */
export interface ProbeClient {
  load(): Promise<void>;
  dispose(): Promise<void>;
  readonly engines: readonly ServerEngine[];
  readonly limits?: Limits;
}

export interface ProbeResult {
  engines: readonly ServerEngine[];
  limits?: Limits;
}

/**
 * Connects once (`hello`/`welcome`), reads the server's engines and limits and disconnects.
 * The client is always disposed, also when the handshake fails.
 */
export async function probeServer(
  createClient: () => ProbeClient | Promise<ProbeClient>,
): Promise<ProbeResult> {
  const client = await createClient();
  try {
    await client.load();
    return { engines: [...client.engines], ...(client.limits ? { limits: client.limits } : {}) };
  } finally {
    await client.dispose().catch(() => undefined);
  }
}
