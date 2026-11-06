// @vitest-environment jsdom
import type { TbPosition } from '@daisychess/endgames';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HumanGameLock } from '../live/lock';
import { usePlayStore } from '../play/playStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { abortError, type LichessTablebaseClient } from './lichessTablebase';
import type { LocalCoverage, LocalTablebase } from './localTablebase';
import {
  configureTablebase,
  HIGH_HALFMOVE,
  isAbortError,
  LOOKUP_DEBOUNCE_MS,
  opponentPolicyFor,
  probeTablebase,
  resetTablebaseStore,
  resolveTablebase,
  sameGame,
  tablebaseProbe,
  useTablebaseStore,
} from './tablebaseStore';

const KQK = '8/8/8/8/8/2k5/8/KQ6 w - - 0 1';
const KQKP = '4Q3/8/8/8/8/2k5/p7/K7 w - - 0 1';
const KQKP_HIGH = `4Q3/8/8/8/8/2k5/p7/K7 w - - ${HIGH_HALFMOVE} 60`;
const KRPKR = '1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1';
const KQPKQ = '1K6/1P1k4/8/8/8/8/q7/2Q5 w - - 0 1';

const pos = (fen: string, extra: Partial<TbPosition> = {}): TbPosition => ({
  fen,
  category: 'win',
  moves: [],
  ...extra,
});

const COVER: Record<string, LocalCoverage> = {
  [KQK]: { wdl: true, dtz: true, missing: [] },
  [KQKP]: { wdl: true, dtz: false, missing: [] },
  [KQKP_HIGH]: { wdl: true, dtz: false, missing: [] },
  [KRPKR]: { wdl: false, dtz: false, missing: ['KRPvKR.rtbw', 'KRvKR.rtbw'] },
  [KQPKQ]: { wdl: false, dtz: false, missing: ['KQPvKQ.rtbw'] },
};

/** Promise that rejects with an AbortError when the signal aborts. */
const abortable = <T>(signal: AbortSignal | undefined, value: Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    signal?.addEventListener('abort', () => reject(abortError()));
    value.then(resolve, reject);
  });

let lock: HumanGameLock = null;
let lichessAnswer: (fen: string) => Promise<TbPosition | null>;
let lichessAvailable = true;
const cache = new Map<string, TbPosition>();

const lichess = {
  probe: vi.fn((fen: string, o?: { signal?: AbortSignal }) =>
    abortable(o?.signal, lichessAnswer(fen)),
  ),
  available: vi.fn(() => lichessAvailable),
  blockedUntil: () => 0,
  blockedReason: () => null,
  requestCount: () => 0,
  abortAll: vi.fn(),
} satisfies LichessTablebaseClient;

const local = {
  probe: vi.fn(async (fen: string, o?: { signal?: AbortSignal }) => {
    if (o?.signal?.aborted) throw abortError();
    return COVER[fen]?.wdl ? pos(fen, { category: 'draw' }) : null;
  }),
  coverage: vi.fn(async (fen: string) => COVER[fen] ?? { wdl: false, dtz: false, missing: [] }),
  reset: vi.fn(),
  running: () => false,
} satisfies LocalTablebase;

const cacheDep = {
  get: vi.fn(async (fen: string) => cache.get(fen)),
  put: vi.fn(async (fen: string, p: TbPosition) => {
    cache.set(fen, p);
  }),
};

beforeEach(() => {
  lock = null;
  lichessAvailable = true;
  lichessAnswer = async (fen) => pos(fen, { dtm: 9 });
  cache.clear();
  vi.clearAllMocks();
  useSettingsStore.getState().set({ tablebase: 'online' });
  configureTablebase({ lichess, local, cache: cacheDep, lock: () => lock });
  resetTablebaseStore();
});

afterEach(() => {
  vi.useRealTimers();
  resetTablebaseStore();
  useSettingsStore.getState().set({ tablebase: 'online' });
});

describe('resolveTablebase: refusals', () => {
  it('setting off: nothing is asked', async () => {
    useSettingsStore.getState().set({ tablebase: 'off' });
    expect(await resolveTablebase(KQK)).toEqual({ ok: false, reason: 'off' });
    expect(cacheDep.get).not.toHaveBeenCalled();
    expect(local.probe).not.toHaveBeenCalled();
    expect(lichess.probe).not.toHaveBeenCalled();
  });

  it('fair play: no lookup of any kind during a human game', async () => {
    for (const l of ['live', 'room', 'engine'] as const) {
      lock = l;
      expect(await resolveTablebase(KRPKR)).toEqual({ ok: false, reason: 'locked' });
      expect(await probeTablebase(KQK)).toBeNull();
    }
    expect(cacheDep.get).not.toHaveBeenCalled();
    expect(local.probe).not.toHaveBeenCalled();
    expect(lichess.probe).not.toHaveBeenCalled();
  });

  it('ineligible: castling rights, more than 7 pieces, invalid FEN', async () => {
    for (const fen of [
      'r3k3/8/8/8/8/8/8/4K2R w Kq - 0 1',
      '4k3/pppp4/8/8/8/8/PPP5/4K3 w - - 0 1',
      'nonsense',
    ]) {
      expect(await resolveTablebase(fen)).toEqual({ ok: false, reason: 'ineligible' });
    }
    expect(lichess.probe).not.toHaveBeenCalled();
  });

  it('a human game starting during the network request discards the answer', async () => {
    lichessAnswer = async (fen) => {
      lock = 'live';
      return pos(fen);
    };
    expect(await resolveTablebase(KRPKR)).toEqual({ ok: false, reason: 'locked' });
    expect(cacheDep.put).not.toHaveBeenCalled();
  });
});

describe('resolveTablebase: source order', () => {
  it('the cache first (a lichess answer)', async () => {
    cache.set(KRPKR, pos(KRPKR, { dtm: 41 }));
    expect(await resolveTablebase(KRPKR)).toEqual({
      ok: true,
      answer: { pos: pos(KRPKR, { dtm: 41 }), source: 'lichess' },
    });
    expect(local.probe).not.toHaveBeenCalled();
    expect(lichess.probe).not.toHaveBeenCalled();
  });

  it('local tables before the network, even online', async () => {
    const r = await resolveTablebase(KQK);
    expect(r).toMatchObject({ ok: true, answer: { source: 'local' } });
    expect(lichess.probe).not.toHaveBeenCalled();
    expect(cacheDep.put).not.toHaveBeenCalled(); // local answers are not cached
  });

  it('WDL-only local tables with a high halfmove clock: the API first, local as the fallback', async () => {
    expect(await resolveTablebase(KQKP)).toMatchObject({ ok: true, answer: { source: 'local' } });
    expect(lichess.probe).not.toHaveBeenCalled();

    expect(await resolveTablebase(KQKP_HIGH)).toMatchObject({
      ok: true,
      answer: { source: 'lichess' },
    });
    expect(lichess.probe).toHaveBeenCalledTimes(1);
    expect(cacheDep.put).toHaveBeenCalledWith(KQKP_HIGH, expect.objectContaining({ dtm: 9 }));

    cache.clear();
    lichessAnswer = async () => null;
    expect(await resolveTablebase(KQKP_HIGH)).toMatchObject({
      ok: true,
      answer: { source: 'local' },
    });

    cache.clear();
    vi.clearAllMocks();
    lichessAvailable = false;
    expect(await resolveTablebase(KQKP_HIGH)).toMatchObject({
      ok: true,
      answer: { source: 'local' },
    });
    expect(lichess.probe).not.toHaveBeenCalled();

    lichessAvailable = true;
    useSettingsStore.getState().set({ tablebase: 'local' });
    expect(await resolveTablebase(KQKP_HIGH)).toMatchObject({
      ok: true,
      answer: { source: 'local' },
    });
    expect(lichess.probe).not.toHaveBeenCalled();
  });

  it('the API when the tables are not on the device; the answer is cached', async () => {
    const r = await resolveTablebase(KRPKR);
    expect(r).toEqual({ ok: true, answer: { pos: pos(KRPKR, { dtm: 9 }), source: 'lichess' } });
    expect(cache.get(KRPKR)?.dtm).toBe(9);
    expect(local.probe).not.toHaveBeenCalled();
  });

  it('setting local: never the network; needs-download names the rook pack', async () => {
    useSettingsStore.getState().set({ tablebase: 'local' });
    expect(await resolveTablebase(KRPKR)).toEqual({
      ok: false,
      reason: 'needs-download',
      pack: 'rook',
    });
    expect(await resolveTablebase(KQPKQ)).toEqual({ ok: false, reason: 'unavailable' });
    expect(lichess.probe).not.toHaveBeenCalled();
  });

  it('a cooling-down or failing API degrades to needs-download / unavailable', async () => {
    lichessAvailable = false;
    expect(await resolveTablebase(KRPKR)).toEqual({
      ok: false,
      reason: 'needs-download',
      pack: 'rook',
    });
    expect(lichess.probe).not.toHaveBeenCalled();
    lichessAvailable = true;
    lichessAnswer = async () => null;
    expect(await resolveTablebase(KQPKQ)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('a failing local probe falls through to the API', async () => {
    local.probe.mockResolvedValueOnce(null);
    expect(await resolveTablebase(KQK)).toMatchObject({ ok: true, answer: { source: 'lichess' } });
  });

  it('tablebaseProbe and opponentPolicyFor', async () => {
    expect((await tablebaseProbe.probe(KRPKR))?.dtm).toBe(9);
    expect(opponentPolicyFor({ pos: pos(KQK), source: 'lichess' })).toBe('dtz');
    expect(opponentPolicyFor({ pos: pos(KQK, { dtz: 3 }), source: 'local' })).toBe('dtz');
    expect(opponentPolicyFor({ pos: pos(KQK), source: 'local' })).toBe('wdlTrappy');
  });
});

describe('aborts', () => {
  it("the caller's signal", async () => {
    let release!: () => void;
    lichessAnswer = (fen) => new Promise((r) => (release = () => r(pos(fen))));
    const ctl = new AbortController();
    const p = resolveTablebase(KRPKR, { signal: ctl.signal });
    await vi.waitFor(() => expect(lichess.probe).toHaveBeenCalled());
    ctl.abort();
    await expect(p).rejects.toSatisfy(isAbortError);
    release();
    const pre = new AbortController();
    pre.abort();
    await expect(resolveTablebase(KRPKR, { signal: pre.signal })).rejects.toSatisfy(isAbortError);
  });

  it('cancelAll and a game change abort running probes; moves of the same game do not', async () => {
    lichessAnswer = () => new Promise(() => undefined);
    const a = resolveTablebase(KRPKR);
    await vi.waitFor(() => expect(lichess.probe).toHaveBeenCalledTimes(1));
    useTablebaseStore.getState().cancelAll();
    await expect(a).rejects.toSatisfy(isAbortError);

    useGameStore.getState().loadFen(KRPKR);
    const b = resolveTablebase(KRPKR);
    await vi.waitFor(() => expect(lichess.probe).toHaveBeenCalledTimes(2));
    let settled = false;
    b.catch(() => undefined).finally(() => (settled = true));
    expect(useGameStore.getState().makeMove('c1', 'c2')).toBe(true); // same game, one move on
    expect(useGameStore.getState().moves).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    useGameStore.getState().loadFen(KQK); // another game
    await expect(b).rejects.toSatisfy(isAbortError);
  });

  it('sameGame: extensions and take-backs are the same game', () => {
    const m = (san: string) => ({ san, from: 'a1', to: 'a2', fen: '' });
    const g = { startFen: 'x', moves: [m('e4'), m('e5')] };
    expect(sameGame(g, { startFen: 'x', moves: [m('e4'), m('e5'), m('Nf3')] })).toBe(true);
    expect(sameGame(g, { startFen: 'x', moves: [m('e4')] })).toBe(true);
    expect(sameGame(g, { startFen: 'x', moves: [m('d4')] })).toBe(false);
    expect(sameGame(g, { startFen: 'y', moves: g.moves })).toBe(false);
  });
});

describe('lookup (analysis board)', () => {
  it('debounces 300 ms; only the last FEN is looked up', async () => {
    vi.useFakeTimers();
    const s = useTablebaseStore.getState();
    s.lookup(KQK);
    expect(useTablebaseStore.getState().current).toEqual({ fen: KQK, status: 'loading' });
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS - 1);
    s.lookup(KRPKR);
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS - 1);
    expect(lichess.probe).not.toHaveBeenCalled();
    expect(local.coverage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(useTablebaseStore.getState().current).toEqual({
      fen: KRPKR,
      status: 'done',
      answer: { pos: pos(KRPKR, { dtm: 9 }), source: 'lichess' },
    });
    expect(lichess.probe).toHaveBeenCalledTimes(1);
    // The same FEN again: no new lookup.
    s.lookup(KRPKR);
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    expect(lichess.probe).toHaveBeenCalledTimes(1);
    s.lookup(null);
    expect(useTablebaseStore.getState().current).toEqual({ fen: null, status: 'idle' });
  });

  it('refusals show at once; unavailable carries the reason and the pack', async () => {
    vi.useFakeTimers();
    const s = useTablebaseStore.getState();
    s.lookup('4k3/pppp4/8/8/8/8/PPP5/4K3 w - - 0 1');
    expect(useTablebaseStore.getState().current).toMatchObject({
      status: 'disabled',
      reason: 'ineligible',
    });
    useSettingsStore.getState().set({ tablebase: 'local' });
    s.lookup(KRPKR);
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    expect(useTablebaseStore.getState().current).toEqual({
      fen: KRPKR,
      status: 'unavailable',
      reason: 'needs-download',
      pack: 'rook',
    });
  });

  it('the setting: off disables and cancels the network, back online looks up again', async () => {
    vi.useFakeTimers();
    useTablebaseStore.getState().lookup(KRPKR);
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    expect(useTablebaseStore.getState().current.status).toBe('done');
    useSettingsStore.getState().set({ tablebase: 'off' });
    expect(lichess.abortAll).toHaveBeenCalled();
    expect(useTablebaseStore.getState().current).toEqual({
      fen: KRPKR,
      status: 'disabled',
      reason: 'off',
    });
    useSettingsStore.getState().set({ tablebase: 'online' });
    expect(useTablebaseStore.getState().current.status).toBe('loading');
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    expect(useTablebaseStore.getState().current.status).toBe('done');
  });

  it('a human game starting clears the result and cancels everything', async () => {
    vi.useFakeTimers();
    useTablebaseStore.getState().lookup(KRPKR);
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    expect(useTablebaseStore.getState().current.answer).toBeDefined();
    lock = 'engine';
    usePlayStore.setState({}); // the lock follows the play/live/room stores
    expect(lichess.abortAll).toHaveBeenCalled();
    expect(useTablebaseStore.getState().current).toEqual({
      fen: KRPKR,
      status: 'disabled',
      reason: 'locked',
    });
    lock = null;
    usePlayStore.setState({});
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    expect(useTablebaseStore.getState().current.status).toBe('done');
  });

  it('a lookup aborted by a game change can run again for the same FEN', async () => {
    vi.useFakeTimers();
    lichessAnswer = () => new Promise(() => undefined);
    useTablebaseStore.getState().lookup(KRPKR);
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    useGameStore.getState().loadFen(KQK);
    useGameStore.getState().loadFen(KRPKR);
    await vi.advanceTimersByTimeAsync(0);
    expect(useTablebaseStore.getState().current).toEqual({ fen: null, status: 'idle' });
    lichessAnswer = async (fen) => pos(fen);
    useTablebaseStore.getState().lookup(KRPKR);
    await vi.advanceTimersByTimeAsync(LOOKUP_DEBOUNCE_MS);
    expect(useTablebaseStore.getState().current.status).toBe('done');
  });
});
