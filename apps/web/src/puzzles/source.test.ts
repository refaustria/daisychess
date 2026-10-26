import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  buildIndex,
  type PuzzleDictionary,
  type PuzzleIndex,
  type PuzzleRow,
  type Shard,
  type Starter,
} from '@daisychess/puzzles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configurePuzzleCache, getCachedShard, listCachedShards, putCachedShard } from './cache';
import { configurePuzzlesStorage, markSeen, updatePuzzlesState } from './puzzlesState';
import {
  APP_PUZZLES_URL,
  configurePuzzleSource,
  fetchShard,
  INDEX_MAX_AGE_MS,
  INDEX_RETRY_MS,
  loadIndex,
  localPuzzles,
  nextPuzzle,
  offlinePlan,
  prefetchOffline,
  puzzleBase,
} from './source';
import { setStarterImporter } from './starter';

const native = vi.hoisted(() => ({ value: false }));
vi.mock('../platform', () => ({ isNativeApp: () => native.value }));

const BASE = 'https://example.test/puzzles/v1/';
const FEN = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
const DICT: PuzzleDictionary = {
  themes: ['fork', 'mate'],
  openings: ['Sicilian_Defense', 'Sicilian_Defense_Open'],
  families: [0],
};

let fileNo = 0;
const hex16 = (n: number): string => n.toString(16).padStart(16, '0');

/** Rows of one band: `n` puzzles with ratings band+10…, theme fork (mate for every 5th). */
function rows(band: number, n: number, prefix = `b${band}`): PuzzleRow[] {
  return Array.from({ length: n }, (_, i): PuzzleRow => [
    `${prefix}x${i}`,
    FEN,
    'g1h1 d1d8',
    band + 10 + (i % 80),
    70,
    i % 5 === 0 ? [1] : [0],
    i % 7 === 0 ? [0, 1] : [],
    '',
  ]);
}

interface Fixture {
  index: PuzzleIndex;
  files: Map<string, string>;
}

/** An index with `perBand` shards of `size` rows for each band, dataset `dataset`. */
function fixture(
  bands: number[],
  opts: { perBand?: number; size?: number; dataset?: string } = {},
): Fixture {
  const dataset = opts.dataset ?? 'ds1';
  const files = new Map<string, string>();
  const shards = bands.flatMap((band) =>
    Array.from({ length: opts.perBand ?? 1 }, (_, k) => {
      const shard: Shard = {
        format: 1,
        dataset,
        band,
        rows: rows(band, opts.size ?? 20, `${dataset}b${band}s${k}`),
      };
      const text = JSON.stringify(shard);
      const file = `shards/${band}-${hex16(++fileNo)}.json`;
      files.set(file, text);
      return { band, rows: shard.rows, file, bytes: text.length };
    }),
  );
  const index = buildIndex({
    dataset: { source: 'test', sha256: dataset, lastModified: '', builtAt: '' },
    dictionary: DICT,
    shards,
  });
  files.set('index.json', JSON.stringify(index));
  return { index, files };
}

type Route = string | number | Error;

/** A fake `fetch` serving `routes` (path → body, status or thrown error) below {@link BASE}. */
function serve(routes: Map<string, Route>) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url.slice(BASE.length));
    expect(init?.credentials).toBe('omit');
    const r = routes.get(url.slice(BASE.length)) ?? 404;
    if (r instanceof Error) throw r;
    if (typeof r === 'number') return { ok: false, status: r, text: async () => '' } as Response;
    return { ok: true, status: 200, text: async () => r } as Response;
  });
  return { fetch, calls, shardCalls: () => calls.filter((c) => c.startsWith('shards/')) };
}

function tinyStarter(ratings: number[]): Starter {
  return {
    format: 1,
    dataset: 'starter',
    themes: ['fork', 'mate'],
    openings: [],
    rows: ratings.map((r, i): PuzzleRow => [`s${i}`, FEN, 'g1h1 d1d8', r, 70, [0], [], '']),
    daily: [],
  };
}

let now = 1_000_000_000;

beforeEach(() => {
  now = 1_000_000_000;
  native.value = false;
  configurePuzzleCache(new IDBFactory(), { clock: () => now });
  configurePuzzlesStorage(null);
  setStarterImporter(async () => tinyStarter([1500, 1550]));
});

afterEach(() => {
  configurePuzzleSource({});
  configurePuzzleCache(undefined);
  configurePuzzlesStorage(undefined);
  setStarterImporter(null);
  vi.restoreAllMocks();
});

const use = (routes: Map<string, Route>) => {
  const s = serve(routes);
  configurePuzzleSource({ fetch: s.fetch, base: BASE, now: () => now });
  return s;
};

/** A deterministic random source. */
const seq = (seed = 1) => {
  let a = seed;
  return () => {
    a = (a * 16807) % 2147483647;
    return (a - 1) / 2147483646;
  };
};

describe('puzzleBase', () => {
  it('is the same origin on the web', () => {
    configurePuzzleSource({});
    expect(puzzleBase()).toBe(`${location.origin}/puzzles/v1/`);
  });

  it('is the play.daisychess.org constant inside the app', () => {
    configurePuzzleSource({});
    native.value = true;
    expect(puzzleBase()).toBe(APP_PUZZLES_URL);
    expect(APP_PUZZLES_URL).toBe('https://play.daisychess.org/puzzles/v1/');
  });

  it('honours an explicit base and adds the trailing slash', () => {
    configurePuzzleSource({ base: 'https://x.test/p' });
    expect(puzzleBase()).toBe('https://x.test/p/');
  });
});

describe('loadIndex', () => {
  it('fetches, validates and stores the index; fresh copies need no request', async () => {
    const f = fixture([1500]);
    const s = use(new Map(f.files));
    expect(await loadIndex()).toEqual(f.index);
    expect(await loadIndex()).toEqual(f.index);
    expect(s.calls).toEqual(['index.json']);
    // A new page (memory forgotten) reads the stored copy while it is fresh.
    configurePuzzleSource({ fetch: s.fetch, base: BASE, now: () => now });
    now += INDEX_MAX_AGE_MS - 1;
    expect(await loadIndex()).toEqual(f.index);
    expect(s.calls).toEqual(['index.json']);
  });

  it('refreshes after 24 h and keeps the stale copy when the refresh fails', async () => {
    const f = fixture([1500]);
    const routes = new Map<string, Route>(f.files);
    const s = use(routes);
    await loadIndex();
    now += INDEX_MAX_AGE_MS + 1;
    routes.set('index.json', new TypeError('offline'));
    expect(await loadIndex()).toEqual(f.index);
    expect(s.calls).toEqual(['index.json', 'index.json']);
    // No new attempt within the retry pause …
    expect(await loadIndex()).toEqual(f.index);
    expect(s.calls).toHaveLength(2);
    // … then the next one succeeds.
    now += INDEX_RETRY_MS;
    const g = fixture([1600], { dataset: 'ds2' });
    routes.set('index.json', g.files.get('index.json')!);
    expect(await loadIndex()).toEqual(g.index);
  });

  it('is null without any copy; an invalid index is not data', async () => {
    const routes = new Map<string, Route>([['index.json', '{"format":1}']]);
    use(routes);
    expect(await loadIndex()).toBeNull();
    configurePuzzleSource({ fetch: serve(new Map([['index.json', 'nope']])).fetch, base: BASE });
    expect(await loadIndex()).toBeNull();
  });

  it('offline mode never fetches', async () => {
    const s = use(new Map(fixture([1500]).files));
    expect(await loadIndex({ offline: true })).toBeNull();
    expect(s.calls).toEqual([]);
  });

  it('shares one request between concurrent callers', async () => {
    const s = use(new Map(fixture([1500]).files));
    await Promise.all([loadIndex(), loadIndex(), loadIndex()]);
    expect(s.calls).toEqual(['index.json']);
  });

  it('drops cached shards of an older dataset when the dataset changes', async () => {
    const a = fixture([1500], { dataset: 'dsA' });
    const routes = new Map<string, Route>(a.files);
    use(routes);
    await loadIndex();
    const fileA = a.index.shards[0]!.file;
    await fetchShard(fileA);
    expect((await listCachedShards()).map((x) => x.file)).toEqual([fileA]);
    const b = fixture([1500], { dataset: 'dsB' });
    for (const [k, v] of b.files) routes.set(k, v);
    now += INDEX_MAX_AGE_MS + 1;
    expect((await loadIndex())?.dataset.sha256).toBe('dsB');
    expect(await listCachedShards()).toEqual([]);
  });
});

describe('fetchShard', () => {
  it('validates and caches a shard', async () => {
    const f = fixture([1500]);
    use(new Map(f.files));
    const file = f.index.shards[0]!.file;
    const shard = await fetchShard(file);
    expect(shard?.rows).toHaveLength(20);
    const cached = await getCachedShard(file);
    expect(cached).toMatchObject({
      file,
      dataset: 'ds1',
      band: 1500,
      bytes: f.files.get(file)!.length,
    });
  });

  it('rejects names that are not shard names without a request', async () => {
    const s = use(new Map());
    for (const bad of ['index.json', '../x.json', 'shards/1500-xyz.json', 'https://evil/x.json']) {
      expect(await fetchShard(bad)).toBeNull();
    }
    expect(s.calls).toEqual([]);
  });

  it('treats invalid files and failed requests as missing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = `shards/1500-${hex16(1)}.json`;
    const b = `shards/1500-${hex16(2)}.json`;
    const c = `shards/1500-${hex16(3)}.json`;
    use(
      new Map<string, Route>([
        [a, JSON.stringify({ format: 1, dataset: 'x', band: 1550, rows: [] })],
        [b, 500],
        [c, new TypeError('offline')],
      ]),
    );
    expect(await fetchShard(a)).toBeNull();
    expect(await fetchShard(b)).toBeNull();
    expect(await fetchShard(c)).toBeNull();
    expect(await listCachedShards()).toEqual([]);
  });

  it('times out a hanging request', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      configurePuzzleSource({ fetch, base: BASE });
      const p = fetchShard(`shards/1500-${hex16(1)}.json`);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('nextPuzzle', () => {
  it('picks an unseen puzzle within the window from a weighted shard', async () => {
    const f = fixture([1300, 1400, 1500, 1600, 1700, 1800]);
    const s = use(new Map(f.files));
    const p = await nextPuzzle({}, 1500, 'normal', { random: seq() });
    expect(p).not.toBeNull();
    expect(p!.source).toBe('lichess');
    expect(p!.rating!).toBeGreaterThanOrEqual(1400);
    expect(p!.rating!).toBeLessThanOrEqual(1700);
    expect(s.shardCalls()).toHaveLength(1);
    // The shard is cached now: the next request does not fetch again for the same shard.
    const before = s.shardCalls().length;
    const q = await nextPuzzle({}, 1500, 'normal', { random: seq() });
    expect(q).not.toBeNull();
    expect(s.shardCalls().length).toBe(before);
  });

  it('applies the theme and opening filters (variation tags inside the shards)', async () => {
    const f = fixture([1500, 1600]);
    use(new Map(f.files));
    const mate = await nextPuzzle({ theme: 'mate' }, 1500, 'normal', { random: seq(3) });
    expect(mate?.themes).toContain('mate');
    const open = await nextPuzzle({ opening: 'Sicilian_Defense_Open' }, 1500, 'normal', {
      random: seq(5),
    });
    expect(open?.openings).toContain('Sicilian_Defense_Open');
  });

  it('skips seen puzzles and excluded ids', async () => {
    const f = fixture([1500], { size: 3 });
    use(new Map(f.files));
    setStarterImporter(async () => tinyStarter([]));
    const ids = ['ds1b1500s0x0', 'ds1b1500s0x1'];
    updatePuzzlesState((s) => ids.reduce(markSeen, s));
    const p = await nextPuzzle({}, 1500, 'normal', { exclude: new Set(['ds1b1500s0x1']) });
    expect(p?.id).toBe('ds1b1500s0x2');
    updatePuzzlesState((s) => markSeen(s, 'ds1b1500s0x2'));
    expect(await nextPuzzle({}, 1500, 'normal')).toBeNull();
  });

  it('fetches at most 3 shards per request', async () => {
    // Every puzzle has been seen: each candidate shard is useless.
    const f = fixture([1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000], { size: 4 });
    const s = use(new Map(f.files));
    setStarterImporter(async () => tinyStarter([]));
    const all = f.index.shards.flatMap((sh) =>
      Array.from({ length: 4 }, (_, i) => `ds1b${sh.band}s0x${i}`),
    );
    updatePuzzlesState((st) => all.reduce(markSeen, st));
    expect(await nextPuzzle({}, 1500, 'normal', { random: seq() })).toBeNull();
    expect(s.shardCalls()).toHaveLength(3);
  });

  it('widens the window ±200 twice, then accepts any band', async () => {
    const far = fixture([2500]);
    use(new Map(far.files));
    setStarterImporter(async () => tinyStarter([]));
    // 1500 normal: [1400, 1700] → [1200, 1900] → [1000, 2100] → any band.
    const p = await nextPuzzle({}, 1500, 'normal', { random: seq() });
    expect(p!.rating!).toBeGreaterThanOrEqual(2500);

    configurePuzzleCache(new IDBFactory());
    configurePuzzleSource({ fetch: serve(new Map(fixture([1800]).files)).fetch, base: BASE });
    const q = await nextPuzzle({}, 1500, 'normal', { random: seq() });
    expect(q!.rating!).toBeGreaterThanOrEqual(1800);
    expect(q!.rating!).toBeLessThanOrEqual(1900);
  });

  it('prefers an in-window starter puzzle to a far shard', async () => {
    const far = fixture([2500]);
    use(new Map(far.files));
    setStarterImporter(async () => tinyStarter([1550]));
    const p = await nextPuzzle({}, 1500, 'normal', { random: seq() });
    expect(p?.id).toBe('s0');
  });

  it('works offline from cached shards and stops fetching after a network error', async () => {
    const f = fixture([1400, 1500, 1600]);
    const routes = new Map<string, Route>(f.files);
    use(routes);
    await loadIndex();
    const cachedFile = f.index.shards.find((x) => x.band === 1600)!.file;
    await fetchShard(cachedFile);
    // Offline now.
    const s = use(
      new Map<string, Route>(
        [...f.files.keys()].map((k) => [k, new TypeError('offline')] as [string, Route]),
      ),
    );
    setStarterImporter(async () => tinyStarter([]));
    for (let i = 0; i < 5; i++) {
      const p = await nextPuzzle({}, 1500, 'normal', { random: seq(i + 1) });
      expect(p!.id.startsWith('ds1b1600')).toBe(true);
    }
    // At most one failed shard request per call (then the request counts as offline).
    expect(s.shardCalls().length).toBeLessThanOrEqual(5);
  });

  it('falls back to the starter without an index', async () => {
    use(new Map([['index.json', new TypeError('offline')]]));
    const p = await nextPuzzle({}, 1500, 'normal', { random: seq() });
    expect(p?.id).toMatch(/^s[01]$/);
  });

  it('returns null when nothing matches anywhere', async () => {
    use(new Map(fixture([1500]).files));
    expect(await nextPuzzle({ theme: 'zugzwang' }, 1500, 'normal')).toBeNull();
  });

  it('ignores a cached shard of another dataset and refetches it', async () => {
    const f = fixture([1500], { size: 5 });
    const s = use(new Map(f.files));
    const file = f.index.shards[0]!.file;
    await putCachedShard({
      file,
      dataset: 'old',
      band: 1500,
      rows: rows(1500, 5, 'old'),
      bytes: 1,
    });
    setStarterImporter(async () => tinyStarter([]));
    const p = await nextPuzzle({}, 1500, 'normal', { random: seq() });
    expect(p!.id.startsWith('ds1')).toBe(true);
    expect(s.shardCalls()).toEqual([file]);
  });

  it('returns null once aborted', async () => {
    use(new Map(fixture([1500]).files));
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await nextPuzzle({}, 1500, 'normal', { signal: ctrl.signal })).toBeNull();
  });
});

describe('offline prefetch', () => {
  it('plans the first two shards of each band within ±300', () => {
    const f = fixture([1100, 1200, 1500, 1800, 1900], { perBand: 3 });
    const plan = offlinePlan(f.index, 1500);
    expect(plan.map((s) => s.band)).toEqual([1200, 1200, 1500, 1500, 1800, 1800]);
    const first = f.index.shards.filter((s) => s.band === 1500).slice(0, 2);
    expect(plan.filter((s) => s.band === 1500)).toEqual(first);
    // The top band is open-ended.
    const top = fixture([2900]);
    expect(offlinePlan(top.index, 3300)).toHaveLength(1);
  });

  it('fetches the missing shards with progress, skipping cached ones', async () => {
    const f = fixture([1400, 1500], { perBand: 2 });
    const s = use(new Map(f.files));
    await loadIndex();
    await fetchShard(f.index.shards[0]!.file);
    const progress = vi.fn();
    const r = await prefetchOffline(1500, { onProgress: progress });
    expect(r).toMatchObject({ ok: true, done: 4, total: 4, failed: 0 });
    expect(r.bytes).toBe(f.index.shards.reduce((n, x) => n + x.bytes, 0));
    expect(s.shardCalls()).toHaveLength(4); // 1 before + 3 missing
    expect(progress).toHaveBeenCalledTimes(5);
    expect(progress.mock.calls[0]![0]).toMatchObject({ done: 0, total: 4 });
    expect((await listCachedShards()).length).toBe(4);
  });

  it('counts failures, reports a missing index and can be cancelled', async () => {
    const f = fixture([1500], { perBand: 2 });
    const routes = new Map<string, Route>(f.files);
    routes.set(f.index.shards[1]!.file, 404);
    use(routes);
    expect(await prefetchOffline(1500)).toMatchObject({ ok: true, done: 2, failed: 1 });

    const ctrl = new AbortController();
    const r = await prefetchOffline(1500, {
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.done === 1) ctrl.abort();
      },
    });
    expect(r).toMatchObject({ ok: false, reason: 'cancelled', done: 1 });

    configurePuzzleCache(new IDBFactory());
    use(new Map([['index.json', 404]]));
    expect(await prefetchOffline(1500)).toMatchObject({ ok: false, reason: 'no-index' });
  });
});

describe('localPuzzles', () => {
  it('returns the cached shards of the stored index plus the starter, without a request', async () => {
    const f = fixture([1500, 1600], { size: 3 });
    use(new Map(f.files));
    await loadIndex();
    await fetchShard(f.index.shards[0]!.file);
    const s = use(new Map());
    const all = await localPuzzles();
    expect(all.map((p) => p.id).sort()).toEqual(
      ['ds1b1500s0x0', 'ds1b1500s0x1', 'ds1b1500s0x2', 's0', 's1'].sort(),
    );
    expect(s.calls).toEqual([]);
  });
});
