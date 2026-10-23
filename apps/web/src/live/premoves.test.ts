import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useGameStore, type Orientation } from '../store/gameStore';
import type { PremoveMode } from '../store/settingsStore';
import { isLegalUci, premoveLabels, premoveShapes, PremoveQueue } from './premoves';
import { flush } from './testing';

let color: Orientation | null = 'white';
let mode: PremoveMode = 'queue';
let q: PremoveQueue;
let changes: (readonly string[])[];
const g = () => useGameStore.getState();
const sans = () => g().moves.map((m) => m.san);

beforeEach(() => {
  g().reset();
  color = 'white';
  mode = 'queue';
  changes = [];
  q = new PremoveQueue({ game: useGameStore, color: () => color, mode: () => mode, onChange: (l) => changes.push(l) });
});
afterEach(() => q.dispose());

describe('PremoveQueue', () => {
  it('executes in order, one per turn of the user', async () => {
    g().makeMove('e2', 'e4');
    q.add('g1f3');
    q.add('f1c4');
    q.add('e1g1');
    g().makeMove('e7', 'e5'); // opponent
    await flush();
    expect(sans()).toEqual(['e4', 'e5', 'Nf3']);
    expect(q.list).toEqual(['f1c4', 'e1g1']);
    g().makeMove('b8', 'c6');
    await flush();
    g().makeMove('g8', 'f6');
    await flush();
    expect(sans()).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'O-O']);
    expect(q.list).toEqual([]);
  });

  it('clears the whole queue when the first premove is illegal on its turn', async () => {
    g().makeMove('e2', 'e4');
    q.add('d1h5');
    q.add('h5f7');
    g().makeMove('e7', 'e5');
    await flush();
    expect(q.list).toEqual(['h5f7']);
    g().makeMove('g7', 'g6'); // blocks h5–f7
    await flush();
    expect(q.list).toEqual([]);
    expect(sans()).toEqual(['e4', 'e5', 'Qh5', 'g6']);
  });

  it('clear() (Escape / right-click) drops everything', () => {
    g().makeMove('e2', 'e4');
    q.add('g1f3');
    q.add('f1c4');
    q.clear();
    expect(q.list).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
  });

  it('waits while the user browses earlier moves, plays at the tip', async () => {
    g().makeMove('e2', 'e4');
    q.add('g1f3');
    g().makeMove('e7', 'e5');
    g().goTo(0);
    await flush();
    expect(sans()).toEqual(['e4', 'e5']);
    g().last();
    await flush();
    expect(sans()).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('single replaces, none ignores; no colour = no premoves', () => {
    mode = 'single';
    g().makeMove('e2', 'e4');
    q.add('g1f3');
    q.add('d2d4');
    expect(q.list).toEqual(['d2d4']);
    mode = 'none';
    q.add('b1c3');
    expect(q.list).toEqual(['d2d4']);
    color = null;
    mode = 'queue';
    q.add('b1c3');
    expect(q.list).toEqual(['d2d4']);
  });

  it('a last-rank premove without a piece promotes to a queen', async () => {
    g().loadFen('7k/P7/8/8/8/8/8/K7 b - - 0 1');
    q.add('a7a8');
    g().makeMove('h8', 'g8');
    await flush();
    expect(sans()).toEqual(['Kg8', 'a8=Q+']);
  });

  it('helpers', () => {
    expect(isLegalUci('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e2e4')).toBe(true);
    expect(isLegalUci('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e2e5')).toBe(false);
    const afterE4E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    expect(premoveLabels(afterE4E5.replace(' w ', ' b '), 'white', ['g1f3', 'f1c4', 'f3g5', 'a1a5'])).toEqual([
      'Nf3',
      'Bc4',
      'Ng5',
      'a1-a5',
    ]);
    expect(premoveShapes(['e2e4'])).toEqual([{ orig: 'e2', dest: 'e4', brush: 'paleGrey' }]);
  });
});
