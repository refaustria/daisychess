import type { TbMove, TbPosition } from '@daisychess/endgames';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { TablebaseSetting } from '../store/settingsStore';
import { abortError } from '../endgames/lichessTablebase';
import type { TbResolution } from '../endgames/tablebaseStore';
import type { MoveDetail, MoveDetails } from './details';
import {
  computeOverlay,
  doneVerdicts,
  eligiblePlies,
  installTablebaseOverlay,
  setOverlayResolver,
  tbBadgeTitle,
  tbCommentaryText,
  tbDisplayKind,
  tbVerdictAt,
  verdictOf,
  type OverlayReviewState,
  type ReviewTbVerdict,
  type TbResolver,
} from './tablebaseOverlay';

// K+Q vs K: Qb3+?? Kxb3 leaves the bare kings.
const KQK = '8/8/8/8/8/2k5/8/KQ6 w - - 0 1';
const KQK_AFTER = '8/8/8/8/8/1Qk5/8/K7 b - - 1 1';
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// ≤ 7 pieces but castling rights: not in the tablebase.
const CASTLING = 'r3k3/8/8/8/8/8/8/4K3 b q - 0 1';

const move = (
  uci: string,
  san: string,
  category: TbMove['category'],
  extra: Partial<TbMove> = {},
): TbMove => ({
  uci,
  san,
  category,
  zeroing: false,
  checkmate: false,
  stalemate: false,
  ...extra,
});

/** White to move wins; Qb3+ throws it away, Qe1+/Qd1 keep it. */
const POS_1: TbPosition = {
  fen: KQK,
  category: 'win',
  dtm: 17,
  dtz: 17,
  moves: [
    move('b1b3', 'Qb3+', 'draw', { dtz: 0 }),
    move('b1e1', 'Qe1+', 'loss', { dtm: -16, dtz: -16 }),
    move('b1d1', 'Qd1', 'loss', { dtm: -18, dtz: -18 }),
  ],
};
/** Black draws only with Kxb3. */
const POS_2: TbPosition = {
  fen: KQK_AFTER,
  category: 'draw',
  moves: [move('c3b3', 'Kxb3', 'draw', { zeroing: true }), move('c3d4', 'Kd4', 'win', { dtm: 19 })],
};

function detail(ply: number, fenBefore: string, playedUci: string, playedSan: string): MoveDetail {
  // Only the fields the overlay reads matter here.
  return {
    ply,
    mover: fenBefore.split(' ')[1] === 'b' ? 'black' : 'white',
    moveLabel: '1.',
    playedUci,
    playedSan,
    bestLine: [],
    bestLineSan: '',
    bestLineMoves: [],
    bestLineFen: fenBefore,
    fenBefore,
    fenAfter: fenBefore,
    evalBeforeWhite: { cp: 0 },
    evalAfterWhite: { cp: 0 },
    swing: '',
    winProbLoss: 0,
    classification: 'good',
    playedIsBest: false,
  };
}

const DETAILS: MoveDetails = {
  1: detail(1, KQK, 'b1b3', 'Qb3+'),
  2: detail(2, KQK_AFTER, 'c3b3', 'Kxb3'),
};

const ANSWERS: Record<string, TbPosition> = { [KQK]: POS_1, [KQK_AFTER]: POS_2 };

const answer =
  (source: 'lichess' | 'local' = 'lichess'): TbResolver =>
  async (fen) => {
    const pos = ANSWERS[fen];
    return pos ? { ok: true, answer: { pos, source } } : { ok: false, reason: 'unavailable' };
  };

/** Resolves when `fn` returns true (polling the microtask/timer queue). */
async function until(fn: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 1));
  }
}

afterEach(() => setOverlayResolver(undefined));

describe('eligiblePlies', () => {
  it('keeps plies with ≤ 7 pieces and no castling rights, ascending', () => {
    const details: MoveDetails = {
      3: detail(3, CASTLING, 'e8d8', 'Kd8'),
      2: DETAILS[2]!,
      1: detail(1, START, 'e2e4', 'e4'),
      4: DETAILS[1]!,
    };
    expect(eligiblePlies(details)).toEqual([2, 4]);
    expect(eligiblePlies({})).toEqual([]);
  });
});

describe('verdictOf', () => {
  it('judges the move and adds the distances after it', () => {
    expect(verdictOf(POS_1, 'b1b3')).toEqual({
      uci: 'b1b3',
      san: 'Qb3+',
      before: 'win',
      after: 'draw',
      kind: 'thrown',
      keepers: ['b1e1', 'b1d1'],
      dtmBefore: 17,
      dtzBefore: 17,
      dtzAfter: 0,
    });
    expect(verdictOf(POS_1, 'b1e1')).toMatchObject({ kind: 'kept', dtmAfter: -16 });
    expect(verdictOf(POS_2, 'c3b3')).toMatchObject({ kind: 'only', keepers: ['c3b3'] });
    expect(verdictOf(POS_1, 'a1a2')).toBeUndefined();
  });
});

describe('computeOverlay', () => {
  it('probes every eligible ply in order and publishes progress', async () => {
    const seen: string[] = [];
    const progress: number[] = [];
    const r = await computeOverlay(DETAILS, {
      signal: new AbortController().signal,
      resolve: async (fen, o) => {
        seen.push(fen);
        return answer()(fen, o);
      },
      onProgress: (o) => progress.push(Object.keys(o.verdicts).length),
    });
    expect(seen).toEqual([KQK, KQK_AFTER]);
    expect(progress).toEqual([1, 2]);
    expect(r.stop).toBeUndefined();
    expect(r.overlay.status).toBe('done');
    expect(r.overlay.source).toBe('lichess');
    expect(r.overlay.missed).toBe(0);
    expect(r.overlay.verdicts[1]?.kind).toBe('thrown');
    expect(r.overlay.verdicts[2]?.kind).toBe('only');
  });

  it('mixed sources; missed plies are counted; no answer at all is unavailable', async () => {
    let n = 0;
    const mixed = await computeOverlay(DETAILS, {
      signal: new AbortController().signal,
      resolve: (fen, o) => answer(n++ === 0 ? 'local' : 'lichess')(fen, o),
    });
    expect(mixed.overlay.source).toBe('mixed');

    const partial = await computeOverlay(DETAILS, {
      signal: new AbortController().signal,
      resolve: async (fen, o) =>
        fen === KQK ? answer()(fen, o) : { ok: false, reason: 'needs-download', pack: 'rook' },
    });
    expect(partial.overlay).toMatchObject({ status: 'done', missed: 1 });
    expect(Object.keys(partial.overlay.verdicts)).toEqual(['1']);

    const none = await computeOverlay(DETAILS, {
      signal: new AbortController().signal,
      resolve: async () => ({ ok: false, reason: 'unavailable' }),
    });
    expect(none.overlay).toMatchObject({ status: 'unavailable', missed: 2, verdicts: {} });

    const empty = await computeOverlay(
      { 1: detail(1, START, 'e2e4', 'e4') },
      {
        signal: new AbortController().signal,
        resolve: answer(),
      },
    );
    expect(empty.overlay).toMatchObject({ status: 'done', missed: 0, verdicts: {} });
  });

  it('stops at a refusal (off, locked) without rejecting', async () => {
    for (const reason of ['off', 'locked'] as const) {
      const r = await computeOverlay(DETAILS, {
        signal: new AbortController().signal,
        resolve: async (): Promise<TbResolution> => ({ ok: false, reason }),
      });
      expect(r.stop).toBe(reason);
    }
  });

  it('rejects with an AbortError when aborted (before or during a probe)', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      computeOverlay(DETAILS, { signal: ctl.signal, resolve: answer() }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    const mid = new AbortController();
    const run = computeOverlay(DETAILS, {
      signal: mid.signal,
      resolve: async (fen, o) => {
        mid.abort();
        return answer()(fen, o);
      },
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('selectors', () => {
  const reviewed = [] as unknown as NonNullable<OverlayReviewState['reviewed']>;
  const verdicts = { 1: verdictOf(POS_1, 'b1b3')! };

  it('tbVerdictAt: only for the overlay of the shown review', () => {
    const t = { status: 'running' as const, verdicts, missed: 0, reviewed };
    expect(tbVerdictAt({ tablebase: t, reviewed }, 1)?.kind).toBe('thrown');
    expect(tbVerdictAt({ tablebase: t, reviewed }, 2)).toBeUndefined();
    expect(tbVerdictAt({ tablebase: t, reviewed: [] }, 1)).toBeUndefined();
    expect(tbVerdictAt({ reviewed }, 1)).toBeUndefined();
  });

  it('doneVerdicts: only a finished overlay of a done review', () => {
    const done = { status: 'done' as const, verdicts, missed: 0, reviewed };
    expect(doneVerdicts({ status: 'done', tablebase: done, reviewed })).toBe(verdicts);
    expect(
      doneVerdicts({ status: 'done', tablebase: { ...done, status: 'running' }, reviewed }),
    ).toBeUndefined();
    expect(doneVerdicts({ status: 'running', tablebase: done, reviewed })).toBeUndefined();
    expect(doneVerdicts({ status: 'done', tablebase: done, reviewed: [] })).toBeUndefined();
  });
});

describe('display texts', () => {
  const thrown = verdictOf(POS_1, 'b1b3')!;

  it('badge title and kind', () => {
    expect(tbBadgeTitle(thrown)).toBe('Tablebase: throws away the win');
    expect(tbBadgeTitle({ kind: 'thrown', before: 'draw', after: 'loss' })).toBe(
      'Tablebase: throws away the draw',
    );
    expect(tbBadgeTitle({ kind: 'only', before: 'draw', after: 'draw' })).toBe(
      'Tablebase: only move',
    );
    expect(tbBadgeTitle({ kind: 'kept', before: 'win', after: 'win' })).toBe(
      'Tablebase: keeps the win',
    );
    expect(tbBadgeTitle({ kind: 'kept', before: 'draw', after: 'draw' })).toBe(
      'Tablebase: keeps the draw',
    );
    // A single legal move in a lost position keeps nothing.
    expect(tbDisplayKind({ kind: 'only', before: 'loss' })).toBe('kept');
    expect(tbBadgeTitle({ kind: 'only', before: 'loss', after: 'loss' })).toBe(
      'Tablebase: still lost',
    );
  });

  it('move card line (ADR-025 §4 wording)', () => {
    expect(tbCommentaryText(thrown, KQK)).toBe(
      'Tablebase: Qb3+ throws away the win — after it the position is a draw; Qe1+ keeps it.',
    );
    expect(tbCommentaryText({ ...thrown, keepers: ['b1e1'] }, KQK)).toBe(
      'Tablebase: Qb3+ throws away the win — after it the position is a draw; Qe1+ was the only move that keeps it.',
    );
    const lost: ReviewTbVerdict = {
      ...thrown,
      before: 'draw',
      after: 'loss',
      dtmAfter: 45,
      keepers: ['b1d1'],
    };
    expect(tbCommentaryText(lost, KQK)).toBe(
      'Tablebase: Qb3+ loses — after it the position is lost (mate in 23); Qd1 was the only move that holds the draw.',
    );
    expect(tbCommentaryText(verdictOf(POS_2, 'c3b3')!, KQK_AFTER)).toBe(
      'Only move (tablebase): Kxb3 holds the draw.',
    );
    expect(tbCommentaryText({ ...thrown, kind: 'only', after: 'win' }, KQK)).toBe(
      'Only move (tablebase): Qb3+ keeps the win.',
    );
    expect(tbCommentaryText(verdictOf(POS_1, 'b1e1')!, KQK)).toBe('Tablebase win after Qe1+.');
    expect(tbCommentaryText({ ...thrown, kind: 'kept', before: 'draw', after: 'draw' }, KQK)).toBe(
      'Tablebase draw after Qb3+.',
    );
    // A keeper that is not legal in the position (stale data): no keeper clause.
    expect(tbCommentaryText({ ...thrown, keepers: ['h1h8'] }, KQK)).toBe(
      'Tablebase: Qb3+ throws away the win — after it the position is a draw.',
    );
  });
});

// ---------------------------------------------------------------------------------------------

type TestState = OverlayReviewState;

function setup(initial: TablebaseSetting = 'online') {
  const store = create<TestState>()(() => ({ status: 'idle', moveDetails: {} }));
  let setting = initial;
  const listeners = new Set<(now: TablebaseSetting, prev: TablebaseSetting) => void>();
  const settings = {
    get: () => setting,
    subscribe: (fn: (now: TablebaseSetting, prev: TablebaseSetting) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const setSetting = (next: TablebaseSetting) => {
    const prev = setting;
    setting = next;
    for (const l of listeners) l(next, prev);
  };
  const uninstall = installTablebaseOverlay(store, settings);
  const reviewed = [{ san: 'Qb3+' }] as unknown as NonNullable<TestState['reviewed']>;
  const done = (moveDetails: MoveDetails = DETAILS, r = reviewed) =>
    store.setState({ status: 'done', summary: {}, moveDetails, reviewed: r });
  return { store, setSetting, uninstall, done, reviewed };
}

describe('installTablebaseOverlay', () => {
  let resolve: ReturnType<typeof vi.fn<TbResolver>>;
  let uninstall: (() => void) | undefined;

  beforeEach(() => {
    resolve = vi.fn<TbResolver>(answer());
    setOverlayResolver(resolve);
  });
  afterEach(() => uninstall?.());

  it('runs after a review is done and publishes the verdicts for that review', async () => {
    const t = setup();
    uninstall = t.uninstall;
    expect(t.store.getState().tablebase).toBeUndefined();
    t.done();
    expect(t.store.getState().tablebase).toMatchObject({ status: 'running', reviewed: t.reviewed });
    await until(() => t.store.getState().tablebase?.status === 'done');
    const tb = t.store.getState().tablebase!;
    expect(tb.reviewed).toBe(t.reviewed);
    expect(tb.verdicts[1]?.kind).toBe('thrown');
    expect(tb.verdicts[2]?.kind).toBe('only');
    expect(resolve).toHaveBeenCalledTimes(2);
    // Its own writes do not restart it.
    await new Promise((r) => setTimeout(r, 5));
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('no eligible ply: no overlay and no request', async () => {
    const t = setup();
    uninstall = t.uninstall;
    t.done({ 1: detail(1, START, 'e2e4', 'e4') });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.store.getState().tablebase).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a review that leaves done aborts the run and clears the overlay', async () => {
    let signal: AbortSignal | undefined;
    resolve.mockImplementation(
      (_fen, o) =>
        new Promise<TbResolution>((_, reject) => {
          signal = o.signal;
          o.signal.addEventListener('abort', () => reject(abortError()));
        }),
    );
    const t = setup();
    uninstall = t.uninstall;
    t.done();
    await until(() => signal !== undefined);
    t.store.setState({ status: 'running', summary: undefined });
    expect(signal!.aborted).toBe(true);
    expect(t.store.getState().tablebase).toBeUndefined();
    await new Promise((r) => setTimeout(r, 5));
    expect(t.store.getState().tablebase).toBeUndefined();
  });

  it('another done review restarts it; the old run never writes', async () => {
    const pending: ((r: TbResolution) => void)[] = [];
    resolve.mockImplementation(() => new Promise<TbResolution>((res) => pending.push(res)));
    const t = setup();
    uninstall = t.uninstall;
    t.done();
    await until(() => pending.length === 1);
    const other = [{ san: 'x' }] as unknown as NonNullable<TestState['reviewed']>;
    t.done({ 1: DETAILS[1]! }, other);
    await until(() => pending.length === 2);
    // The first run's answer arrives late: ignored.
    pending[0]!({ ok: true, answer: { pos: POS_1, source: 'lichess' } });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.store.getState().tablebase).toMatchObject({
      status: 'running',
      reviewed: other,
      verdicts: {},
    });
    pending[1]!({ ok: true, answer: { pos: POS_1, source: 'local' } });
    await until(() => t.store.getState().tablebase?.status === 'done');
    expect(t.store.getState().tablebase).toMatchObject({ source: 'local', reviewed: other });
  });

  it('an abort from outside (game change, human game) keeps what arrived as idle', async () => {
    resolve.mockImplementation(async (fen, o) => {
      if (fen === KQK_AFTER) throw abortError();
      return answer()(fen, o);
    });
    const t = setup();
    uninstall = t.uninstall;
    t.done();
    await until(() => t.store.getState().tablebase?.status === 'idle');
    expect(Object.keys(t.store.getState().tablebase!.verdicts)).toEqual(['1']);
  });

  it('a locked refusal ends the run as idle', async () => {
    resolve.mockImplementation(async () => ({ ok: false, reason: 'locked' }));
    const t = setup();
    uninstall = t.uninstall;
    t.done();
    await until(() => t.store.getState().tablebase?.status === 'idle');
  });

  it('setting off clears it; from off it is recomputed', async () => {
    const t = setup();
    uninstall = t.uninstall;
    t.done();
    await until(() => t.store.getState().tablebase?.status === 'done');
    t.setSetting('off');
    expect(t.store.getState().tablebase).toBeUndefined();
    resolve.mockClear();
    t.setSetting('local');
    await until(() => t.store.getState().tablebase?.status === 'done');
    expect(resolve).toHaveBeenCalledTimes(2);
    // A complete overlay is not recomputed by another change.
    resolve.mockClear();
    t.setSetting('online');
    await new Promise((r) => setTimeout(r, 5));
    expect(resolve).not.toHaveBeenCalled();
  });

  it('setting off at install time: nothing runs until it is switched on', async () => {
    const t = setup('off');
    uninstall = t.uninstall;
    t.done();
    await new Promise((r) => setTimeout(r, 5));
    expect(t.store.getState().tablebase).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    t.setSetting('online');
    await until(() => t.store.getState().tablebase?.status === 'done');
  });

  it('a run that missed plies is retried when the setting changes', async () => {
    resolve.mockImplementation(async () => ({ ok: false, reason: 'unavailable' }));
    const t = setup('local');
    uninstall = t.uninstall;
    t.done();
    await until(() => t.store.getState().tablebase?.status === 'unavailable');
    resolve.mockImplementation(answer());
    t.setSetting('online');
    await until(() => t.store.getState().tablebase?.status === 'done');
  });

  it('a refusal "off" mid-run clears it', async () => {
    resolve.mockImplementation(async () => ({ ok: false, reason: 'off' }));
    const t = setup();
    uninstall = t.uninstall;
    t.done();
    await until(() => t.store.getState().tablebase === undefined);
  });

  it('uninstall stops listening', async () => {
    const t = setup();
    t.uninstall();
    t.done();
    await new Promise((r) => setTimeout(r, 5));
    expect(t.store.getState().tablebase).toBeUndefined();
  });
});

describe('reviewStore wiring', () => {
  it('the review store carries the overlay of a done review and drops it on reset', async () => {
    const { useReviewStore } = await import('./reviewStore');
    setOverlayResolver(answer('local'));
    const reviewed = [] as unknown as NonNullable<TestState['reviewed']>;
    useReviewStore.setState({
      status: 'done',
      summary: { moves: [] } as unknown as NonNullable<
        ReturnType<typeof useReviewStore.getState>['summary']
      >,
      moveDetails: DETAILS,
      reviewed,
    });
    await until(() => useReviewStore.getState().tablebase?.status === 'done');
    const s = useReviewStore.getState();
    expect(tbVerdictAt(s, 1)?.kind).toBe('thrown');
    expect(doneVerdicts(s)?.[2]?.kind).toBe('only');
    useReviewStore.getState().reset();
    expect(useReviewStore.getState().tablebase).toBeUndefined();
  });
});
