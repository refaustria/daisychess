import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { configureGameLedger, getLedgerGame } from '../puzzles/gameLedger';
import { installLedger } from '../puzzles/installLedger';
import { usePlayStore } from '../play/playStore';
import { MY_NAMES_KEY } from '../puzzles/userSide';
import { useGameStore } from '../store/gameStore';
import { reviewUserSide, switchReviewSide } from './userSide';

const PGN = '[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 2. Nf3 Nc6 *';

beforeEach(() => {
  localStorage.clear();
  configureGameLedger(new IDBFactory());
  useGameStore.getState().reset();
  useGameStore.getState().loadPgn(PGN);
});

const game = () => useGameStore.getState();

describe('reviewUserSide', () => {
  it('matches a "My names" entry against the PGN headers', async () => {
    localStorage.setItem(MY_NAMES_KEY, JSON.stringify(['bob']));
    expect(await reviewUserSide(game(), 'k1')).toBe('black');
  });

  it('uses the play colour of an engine game', async () => {
    usePlayStore.setState({ mode: 'playing', playerColor: 'black' });
    const off = installLedger();
    try {
      expect(await reviewUserSide(game(), 'k0')).toBe('black');
    } finally {
      off();
      usePlayStore.setState({ mode: 'idle' });
    }
  });

  it('prefers a stored ledger answer over the orientation', async () => {
    await switchReviewSide('k2', 'black');
    expect(game().orientation).toBe('white');
    expect(await reviewUserSide(game(), 'k2')).toBe('black');
  });

  it('falls back to the orientation', async () => {
    expect(await reviewUserSide(game(), 'k3')).toBe('white');
    game().flip();
    expect(await reviewUserSide(game(), 'k3')).toBe('black');
  });
});

describe('switchReviewSide', () => {
  it('creates the ledger entry and persists the side', async () => {
    expect(await getLedgerGame('k4')).toBeUndefined();
    expect(await switchReviewSide('k4', 'black')).toBe('black');
    const entry = await getLedgerGame('k4');
    expect(entry?.userSide).toBe('black');
    expect(entry?.moves).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(await switchReviewSide('k4', 'white')).toBe('white');
    expect(await reviewUserSide(game(), 'k4')).toBe('white');
  });
});
