import type {
  EngineDescriptor as ServerEngine,
  Limits,
  WelcomeNode,
} from '@daisychess/engine-core';
import { authMessage, isAuthError, isDeniedText } from '../server/tokenMessages';
import {
  budgetReason,
  currentMemoryBudget,
  defaultThreadCount,
  type MemoryBudget,
} from './memoryBudget';
import type { WasmBuild } from './WasmEngineClient';
import {
  browserEngineUnsupportedReason,
  NO_THREADS_REASON,
  wasmSupport,
  type WasmSupport,
} from './wasmSupport';

/**
 * Engine registry of the browser: which engines the user can enable for live analysis.
 *
 * Keys: `wasm:lite` (multi-threaded WASM, needs cross-origin isolation), `wasm:lite-single`
 * (single-threaded WASM, works everywhere), `wasm:full` (multi-threaded with the full-strength
 * network, ~99 MB download, opt-in; ADR-010) and `remote:<engineId>` (an engine of the DaisyChess
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
  /** Memory budget of the device (ADR-015); absent = unconstrained (tests, old callers). */
  budget?: MemoryBudget;
  /** WebAssembly features of the browser (`wasmSupport.ts`); absent = everything supported. */
  wasm?: WasmSupport;
}

/** Server discovery result, cached by the analysis store. */
export interface ServerProbeState {
  status: 'idle' | 'probing' | 'ok' | 'error';
  engines?: readonly ServerEngine[];
  limits?: Limits;
  /** Where the server's engines run (`welcome.node`, ADR-020); absent on a standalone server. */
  node?: WelcomeNode;
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
    budget: currentMemoryBudget(),
    wasm: wasmSupport(),
  };
}

/** Browser engines the live analysis may run at once on this device. */
export function maxWasmInstances(env: RegistryEnv): number {
  return env.budget?.maxInstances ?? 2;
}

/**
 * Highest thread count offered for a browser engine: `cores - 1`, capped by the memory budget on
 * constrained devices (iOS: 2).
 */
export function maxWasmThreads(env: RegistryEnv): number {
  const all = Math.max(1, Math.floor(env.hardwareConcurrency) - 1 || 1);
  return env.budget?.constrained ? Math.min(all, env.budget.maxThreads) : all;
}

/** The browser engine used by default: multi-threaded when the page allows it. */
export function defaultWasmKey(env: RegistryEnv = currentEnv()): EngineKey {
  return env.crossOriginIsolated && env.wasm?.threads !== false ? 'wasm:lite' : 'wasm:lite-single';
}

/**
 * Why browser build `build` cannot run on this browser at all (no WebAssembly / SIMD, or no
 * threads for a multi-threaded build); undefined when the browser supports it. Cross-origin
 * isolation is a separate check.
 */
export function wasmBuildUnsupportedReason(build: WasmBuild, env: RegistryEnv): string | undefined {
  if (!env.wasm) return undefined;
  const all = browserEngineUnsupportedReason(env.wasm);
  if (all) return all;
  return build !== 'lite-single' && !env.wasm.threads ? NO_THREADS_REASON : undefined;
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

/**
 * Default thread count of the multi-threaded builds: `min(cores - 1, 4)`, at least 1, capped by
 * the memory budget (same rule as `selectBuild` in WasmEngineClient).
 */
export function defaultThreads(env: RegistryEnv): number {
  const threads = defaultThreadCount(env.hardwareConcurrency);
  return env.budget ? Math.min(threads, env.budget.maxThreads) : threads;
}

/**
 * Marks browser engines that are not enabled as unavailable when enabling them would exceed the
 * memory budget (`displacedBy` replacements stay allowed: they do not add an instance).
 */
function applyMemoryBudget(
  engines: EngineDescriptor[],
  enabledKeys: readonly EngineKey[],
  env: RegistryEnv,
): EngineDescriptor[] {
  if (!env.budget) return engines;
  return engines.map((d) => {
    if (d.backend !== 'wasm' || !d.available || enabledKeys.includes(d.key)) return d;
    const guard = wasmBudgetGuard(d.key, enabledKeys, env);
    return guard.ok ? d : { ...d, available: false, reason: guard.reason };
  });
}

/** The memory-budget part of {@link canEnable} for a browser engine key. */
function wasmBudgetGuard(
  key: EngineKey,
  enabled: readonly EngineKey[],
  env: RegistryEnv,
): GuardResult {
  const displaced = displacedBy(key, enabled);
  const wasm = enabled.filter((k) => k.startsWith('wasm:') && !displaced.includes(k)).length;
  const max = maxWasmInstances(env);
  return wasm >= max
    ? { ok: false, reason: budgetReason({ maxInstances: max }) }
    : { ok: true };
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
  // No WebAssembly SIMD (every shipped build needs it) or no threads: unavailable with the reason.
  const support = (d: EngineDescriptor): EngineDescriptor => {
    const parsed = parseEngineKey(d.key);
    const reason =
      parsed?.backend === 'wasm' ? wasmBuildUnsupportedReason(parsed.build, env) : undefined;
    return reason ? { ...d, available: false, reason } : d;
  };
  const list: EngineDescriptor[] = [
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
  return list.map(support);
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
        ? isAuthError(probe.error)
          ? authMessage()
          : isDeniedText(probe.error ?? '')
            ? probe.error
            : `Server unavailable: ${probe.error ?? 'unknown error'}`
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
  return [
    ...applyMemoryBudget(browserEngines(env), enabledKeys, env),
    ...serverEngines(probe, enabledKeys),
  ];
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
 * than one multi-threaded and one single-threaded WASM instance; the memory budget (ADR-015)
 * lowers that to one browser engine on iOS/low-memory devices.
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
    const unsupported = wasmBuildUnsupportedReason(parsed.build, env);
    if (unsupported) return { ok: false, reason: unsupported };
    if (parsed.build !== 'lite-single' && !env.crossOriginIsolated) {
      return { ok: false, reason: NOT_ISOLATED_REASON };
    }
    // Callers pass `enabled` without the engines `key` displaces (see displacedBy).
    return wasmBudgetGuard(key, enabled, env);
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
  readonly node?: WelcomeNode;
}

export interface ProbeResult {
  engines: readonly ServerEngine[];
  limits?: Limits;
  node?: WelcomeNode;
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
    return {
      engines: [...client.engines],
      ...(client.limits ? { limits: client.limits } : {}),
      ...(client.node ? { node: client.node } : {}),
    };
  } finally {
    await client.dispose().catch(() => undefined);
  }
}
