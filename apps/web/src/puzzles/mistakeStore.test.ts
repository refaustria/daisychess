import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS } from '../trainer/schedule';
import {
  addMistakes,
  clearMistakes,
  configureMistakeStore,
  deleteMistake,
  deleteMistakesOfGame,
  dueMistakes,
  evictionOrder,
  getMistake,
  getScanMarker,
  listMistakes,
  markScanned,
  mistakeStats,
  mistakeStoreKind,
  newSchedule,
  onMistakesChange,
  pruneScanMarkers,
  recordMistakeResult,
  scanMarkerId,
  type MistakeRecord,
} from './mistakeStore';

function rec(id: string, over: Partial<MistakeRecord> = {}): MistakeRecord {
  const createdAt = over.createdAt ?? 1000;
  return {
    id,
    puzzle: {
      id,
      fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
      moves: ['a1a2'],
      themes: [],
      openings: [],
      source: 'mistake',
    },
    gameKey: 'g1',
    ply: 7,
    playedUci: 'd2d3',
    classification: 'blunder',
    evalBeforeWhite: { mate: 1 },
    evalAfterWhite: { cp: 20 },
    createdAt,
    schedule: newSchedule(createdAt),
    ...over,
  };
}

const FACTORIES: [string, () => IDBFactory | null][] = [
  ['indexeddb', () => new IDBFactory()],
  ['memory', () => null],
];

describe.each(FACTORIES)('mistake store (%s)', (kind, factory) => {
  beforeEach(() => configureMistakeStore(factory()));
  afterEach(() => {
    configureMistakeStore(undefined);
    vi.restoreAllMocks();
  });

  it('uses the expected backend', async () => {
    expect(await mistakeStoreKind()).toBe(kind);
  });

  it('adds puzzles once (dedupe by id) and lists them newest first', async () => {
    const added = await addMistakes([rec('m:a', { createdAt: 1 }), rec('m:b', { createdAt: 2 })]);
    expect(added.map((r) => r.id)).toEqual(['m:a', 'm:b']);
    const again = await addMistakes([rec('m:a', { createdAt: 5, ply: 99 })]);
    expect(again).toEqual([]);
    const list = await listMistakes();
    expect(list.map((r) => r.id)).toEqual(['m:b', 'm:a']);
    expect((await getMistake('m:a'))?.ply).toBe(7);
  });

  it('records results with the trainer schedule and lists due puzzles earliest first', async () => {
    await addMistakes([rec('m:a', { createdAt: 10 }), rec('m:b', { createdAt: 20 })]);
    const now = 100;
    const a = await recordMistakeResult('m:a', true, now);
    expect(a?.schedule).toMatchObject({ interval: 1, due: now + DAY_MS, successes: 1 });
    const b = await recordMistakeResult('m:b', false, now);
    expect(b?.schedule).toMatchObject({ interval: 1, due: now, lapses: 1 });
    expect((await dueMistakes(now)).map((r) => r.id)).toEqual(['m:b']);
    expect((await dueMistakes(now + DAY_MS)).map((r) => r.id)).toEqual(['m:b', 'm:a']);
    expect(await mistakeStats(now)).toEqual({ total: 2, due: 1 });
    expect(await recordMistakeResult('m:missing', true, now)).toBeUndefined();
  });

  it('enforces the bound: not-due puzzles go first, oldest first', async () => {
    configureMistakeStore(factory(), { max: 3 });
    const later = { due: 10_000, interval: 3, lapses: 0, successes: 1 };
    await addMistakes([
      rec('m:due-old', { createdAt: 1 }),
      rec('m:notdue-old', { createdAt: 2, schedule: later }),
      rec('m:notdue-new', { createdAt: 3, schedule: later }),
    ]);
    const added = await addMistakes([rec('m:new', { createdAt: 4 })], 5);
    expect(added.map((r) => r.id)).toEqual(['m:new']);
    expect((await listMistakes()).map((r) => r.id).sort()).toEqual(
      ['m:due-old', 'm:new', 'm:notdue-new'].sort(),
    );
  });

  it('keeps scan markers apart from the puzzles', async () => {
    await addMistakes([rec('m:a')]);
    await markScanned('g1', 50, ['m:a', 'm:x'], 60);
    await markScanned('g1', 70, ['m:y'], 80);
    const marker = await getScanMarker('g1');
    expect(marker).toMatchObject({ id: scanMarkerId('g1'), reviewCreatedAt: 70 });
    expect(marker?.ids.sort()).toEqual(['m:a', 'm:x', 'm:y']);
    expect((await listMistakes()).map((r) => r.id)).toEqual(['m:a']);
    expect(await getMistake(scanMarkerId('g1'))).toBeUndefined();
    expect(await mistakeStats(10_000)).toEqual({ total: 1, due: 1 });
  });

  it('deleting a puzzle keeps the marker; deleting a game drops both', async () => {
    await addMistakes([rec('m:a'), rec('m:b', { gameKey: 'g2' })]);
    await markScanned('g1', 1, ['m:a']);
    await deleteMistake('m:a');
    expect(await getMistake('m:a')).toBeUndefined();
    expect(await getScanMarker('g1')).toBeDefined();
    await deleteMistake(scanMarkerId('g1')); // not a puzzle id: ignored
    expect(await getScanMarker('g1')).toBeDefined();
    await deleteMistakesOfGame('g1');
    expect(await getScanMarker('g1')).toBeUndefined();
    expect((await listMistakes()).map((r) => r.id)).toEqual(['m:b']);
  });

  it('prunes markers of games no longer in the ledger', async () => {
    await markScanned('keep', 1, []);
    await markScanned('drop', 1, []);
    expect(await pruneScanMarkers(new Set(['keep']))).toBe(1);
    expect(await getScanMarker('keep')).toBeDefined();
    expect(await getScanMarker('drop')).toBeUndefined();
  });

  it('notifies listeners and clears everything', async () => {
    const l = vi.fn();
    const off = onMistakesChange(l);
    await addMistakes([rec('m:a')]);
    await recordMistakeResult('m:a', true, 5);
    await clearMistakes();
    expect(l).toHaveBeenCalledTimes(3);
    off();
    await addMistakes([rec('m:b')]);
    expect(l).toHaveBeenCalledTimes(3);
    expect(await listMistakes()).toHaveLength(1);
  });

  it('serialises concurrent adds (no lost update, no duplicate)', async () => {
    await Promise.all([
      addMistakes([rec('m:a')]),
      addMistakes([rec('m:a'), rec('m:b')]),
      addMistakes([rec('m:c')]),
    ]);
    expect((await listMistakes()).map((r) => r.id).sort()).toEqual(['m:a', 'm:b', 'm:c']);
  });
});

describe('mistake store fallbacks', () => {
  afterEach(() => {
    configureMistakeStore(undefined);
    vi.restoreAllMocks();
  });

  it('falls back to memory when IndexedDB cannot be opened', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = {
      open: () => {
        throw new Error('SecurityError');
      },
    } as unknown as IDBFactory;
    configureMistakeStore(broken);
    expect(await mistakeStoreKind()).toBe('memory');
    await addMistakes([rec('m:a')]);
    expect(await listMistakes()).toHaveLength(1);
  });
});

describe('evictionOrder', () => {
  it('returns nothing within the bound', () => {
    expect(evictionOrder([rec('m:a')], 1, 0)).toEqual([]);
  });
  it('drops due puzzles only when every other one is gone', () => {
    const later = { due: 50, interval: 1, lapses: 0, successes: 1 };
    const records = [
      rec('m:d1', { createdAt: 1 }),
      rec('m:d2', { createdAt: 2 }),
      rec('m:n1', { createdAt: 3, schedule: later }),
    ];
    expect(evictionOrder(records, 1, 10)).toEqual(['m:n1', 'm:d1']);
  });
});
