/**
 * Maia review hints for the reviewed game (M23-3): requested by the Review panel once a review is
 * done (computed or from a cache), cached in memory and in IndexedDB (`hintCache.ts`), computed on
 * the engine server (`hints.ts`) for what is missing. Partial results are published as they arrive.
 *
 * Availability: only when an engine server is configured, the welcome grants analysis (token) and
 * lists the Maia engines; a refused token gives status `unauthorized` (the panel shows one muted
 * line), every other failure is silent (`unavailable`/`busy`). A failed server is not asked again
 * for {@link HINT_SERVER_COOLDOWN_MS} (same URL and token).
 */
import { reviewGameKey } from '@daisychess/engine-core';
import { create } from 'zustand';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { serverConfigured } from '../review/reviewStore';
import { hintFactoryOverride, hintTiming } from './hintClient';
import { getStoredHints, hintId, putStoredHints } from './hintCache';
import {
  gameLevels,
  hintJobs,
  runHintJobs,
  type CreateMaiaClient,
  type GameLevels,
  type HintRunStatus,
  type HintSourceDetail,
  type MaiaHint,
  type MaiaLevel,
} from './hints';

export type HintStatus =
  | 'idle'
  /** Setting `maiaHints` is off. */
  | 'off'
  | 'running'
  | 'done'
  | 'unavailable'
  | 'unauthorized'
  | 'busy';

export interface HintState {
  status: HintStatus;
  /** Hints of the current game by ply (partial while running). */
  hints: Record<number, MaiaHint>;
  levels?: GameLevels;
  /** The game store's `moves` array the hints belong to (identity check, like the review). */
  forMoves?: readonly unknown[];
  gameKey?: string;
}

export const useMaiaHintStore = create<HintState>()(() => ({ status: 'idle', hints: {} }));

export interface HintRequest {
  startFen: string;
  /** The game's moves; the array identity is kept as {@link HintState.forMoves}. */
  moves: ReadonlyArray<{ from: string; to: string; promotion?: string }>;
  headers: Readonly<Record<string, string>>;
  details: Readonly<Record<number, HintSourceDetail>>;
  /** Setting `maiaHints`. */
  enabled: boolean;
  /** Setting `maiaRating` (used for a side without a PGN rating). */
  fallbackRating: number;
}

export const HINT_SERVER_COOLDOWN_MS = 60_000;
export const MAX_MEMORY_HINTS = 2000;
export const HINT_HANDSHAKE_TIMEOUT_MS = 5_000;

/** id → hint; Map order = least recently used first. */
const memory = new Map<string, MaiaHint>();
const serverFailures = new Map<string, { until: number; status: HintStatus }>();
let current: { key: string; abort: AbortController; promise: Promise<void> } | null = null;

const defaultFactory: CreateMaiaClient = async (engineId) => {
  const { RemoteEngineClient } = await import('../engine/RemoteEngineClient');
  const url = useAnalysisStore.getState().settings.remoteUrl;
  const token = useSettingsStore.getState().serverToken;
  return new RemoteEngineClient({
    ...(url ? { url } : {}),
    ...(token ? { token } : {}),
    engineId,
    handshakeTimeoutMs: HINT_HANDSHAKE_TIMEOUT_MS,
    clientInfo: { name: 'daisychess-web-maia-hints' },
  });
};

/** The Maia client factory in use: the test override, else the review server's (null: none). */
export const maiaClientFactory = (): CreateMaiaClient | null => effectiveFactory();

const effectiveFactory = (): CreateMaiaClient | null => {
  const o = hintFactoryOverride();
  if (o !== undefined) return o;
  return serverConfigured() ? defaultFactory : null;
};

export { setMaiaHintClientFactory } from './hintClient';

/** Cancels the current run and forgets in-memory hints and server failures. */
export function resetMaiaHints(): void {
  current?.abort.abort();
  current = null;
  memory.clear();
  serverFailures.clear();
  useMaiaHintStore.setState(
    { status: 'idle', hints: {}, levels: undefined, forMoves: undefined, gameKey: undefined },
    false,
  );
}

function remember(id: string, hint: MaiaHint): void {
  memory.delete(id);
  memory.set(id, hint);
  while (memory.size > MAX_MEMORY_HINTS) memory.delete(memory.keys().next().value!);
}

const serverKey = (): string =>
  `${useAnalysisStore.getState().settings.remoteUrl ?? ''}\n${useSettingsStore.getState().serverToken}`;

/** Identity of the configured Maia server (URL + token), for the cooldown. */
export const maiaServerKey = serverKey;

/**
 * The failure status of the Maia server while its cooldown runs ({@link HINT_SERVER_COOLDOWN_MS}
 * after `unauthorized`/`unavailable`/`busy`), shared by the hints and the Elo estimate.
 */
export function maiaServerCooldown(key: string = serverKey()): HintStatus | undefined {
  const f = serverFailures.get(key);
  return f && f.until > Date.now() ? f.status : undefined;
}

/** Records a failed Maia run (`unauthorized`/`unavailable`/`busy`) for the cooldown. */
export function noteMaiaServerFailure(
  status: HintStatus | HintRunStatus,
  key: string = serverKey(),
): void {
  if (status === 'unauthorized' || status === 'unavailable' || status === 'busy')
    serverFailures.set(key, { until: Date.now() + HINT_SERVER_COOLDOWN_MS, status });
}

/** Settles when the current hint run ended (immediately when none runs). Never rejects. */
export function maiaHintsSettled(): Promise<void> {
  return current?.promise ?? Promise.resolve();
}

/**
 * Shows (and computes what is missing of) the hints for a reviewed game. Idempotent for the same
 * game, levels, setting and token; a different request cancels the running one. Resolves when the
 * run ended (tests).
 */
export function requestMaiaHints(req: HintRequest): Promise<void> {
  const levels = gameLevels(req.headers, req.fallbackRating);
  const uci = req.moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`);
  const gameKey = reviewGameKey(req.startFen, uci);
  const jobs = req.enabled ? hintJobs(req.details, levels) : [];
  const key = [
    gameKey,
    levels.white.rating,
    levels.black.rating,
    req.enabled,
    serverKey(),
    jobs.map((j) => j.ply).join(','),
  ].join('|');
  if (current?.key === key) {
    // Same request: only the identity of the moves array may have changed (same game reloaded).
    if (useMaiaHintStore.getState().forMoves !== req.moves)
      useMaiaHintStore.setState({ forMoves: req.moves });
    return current.promise;
  }
  current?.abort.abort();
  const abort = new AbortController();
  const signal = abort.signal;
  const isCurrent = () => !signal.aborted;
  const base = { levels, forMoves: req.moves, gameKey };

  if (!req.enabled) {
    useMaiaHintStore.setState({ ...base, status: 'off', hints: {} });
    const promise = Promise.resolve();
    current = { key, abort, promise };
    return promise;
  }

  const ids = new Map(jobs.map((j) => [j.ply, hintId(gameKey, j.ply, j.rating)]));
  const hints: Record<number, MaiaHint> = {};
  for (const j of jobs) {
    const h = memory.get(ids.get(j.ply)!);
    if (h) {
      remember(ids.get(j.ply)!, h);
      hints[j.ply] = h;
    }
  }
  useMaiaHintStore.setState({ ...base, status: 'running', hints });

  const publish = (h: MaiaHint) => {
    if (!isCurrent()) return;
    const s = useMaiaHintStore.getState();
    useMaiaHintStore.setState({ hints: { ...s.hints, [h.ply]: h } });
  };
  const finish = (status: HintStatus) => {
    if (isCurrent()) useMaiaHintStore.setState({ status });
  };

  const promise = (async () => {
    let missing = jobs.filter((j) => !hints[j.ply]);
    if (missing.length > 0) {
      const stored = await getStoredHints(missing.map((j) => ids.get(j.ply)!));
      for (const s of stored) {
        remember(s.id, s.hint);
        publish(s.hint);
      }
      const have = new Set(stored.map((s) => s.id));
      missing = missing.filter((j) => !have.has(ids.get(j.ply)!));
    }
    if (!isCurrent()) return;
    if (missing.length === 0) return finish('done');

    const factory = effectiveFactory();
    if (!factory) return finish('unavailable');
    const sk = serverKey();
    const failure = serverFailures.get(sk);
    if (failure && failure.until > Date.now()) return finish(failure.status);

    const found: { id: string; hint: MaiaHint }[] = [];
    const status = await runHintJobs(missing, {
      ...hintTiming(),
      createClient: factory,
      signal,
      onHint: (h) => {
        const id = hintId(gameKey, h.ply, h.rating);
        remember(id, h);
        found.push({ id, hint: h });
        publish(h);
      },
    });
    if (status === 'unauthorized' || status === 'unavailable' || status === 'busy') {
      serverFailures.set(sk, { until: Date.now() + HINT_SERVER_COOLDOWN_MS, status });
    }
    await putStoredHints(found);
    if (status !== 'aborted') finish(status);
  })().catch((err: unknown) => {
    console.warn('Maia hints failed', err);
    finish('unavailable');
  });
  current = { key, abort, promise };
  return promise;
}

/** The hint state when it belongs to the game on the board, else undefined. */
export function useGameHints(): HintState | undefined {
  const s = useMaiaHintStore();
  const moves = useGameStore((g) => g.moves);
  return s.forMoves === moves ? s : undefined;
}

/** The hint and the mover's level at `ply` of the game on the board, if there is one. */
export function useMaiaHint(
  ply: number,
  mover: 'white' | 'black' | undefined,
): { hint: MaiaHint; level: MaiaLevel } | undefined {
  const hint = useMaiaHintStore((s) => s.hints[ply]);
  const levels = useMaiaHintStore((s) => s.levels);
  const forMoves = useMaiaHintStore((s) => s.forMoves);
  const status = useMaiaHintStore((s) => s.status);
  const moves = useGameStore((g) => g.moves);
  if (!hint || !levels || !mover || forMoves !== moves || status === 'off') return undefined;
  return { hint, level: levels[mover] };
}

/** Non-React lookup (guided tour): the hint at `ply` of the game on the board. */
export function maiaHintAt(ply: number): MaiaHint | undefined {
  const s = useMaiaHintStore.getState();
  if (s.status === 'off' || s.forMoves !== useGameStore.getState().moves) return undefined;
  return s.hints[ply];
}
