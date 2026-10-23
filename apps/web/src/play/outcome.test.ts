import { describe, expect, it } from 'vitest';
import { useGameStore } from '../store/gameStore';
import { gameOutcome } from './outcome';
import { findStrength, MAX_UCI_ELO, strengthOptions, STRENGTH_PRESETS } from './strength';

const at = (fen: string) => {
  useGameStore.getState().loadFen(fen);
  return useGameStore.getState();
};

describe('gameOutcome', () => {
  it('ongoing, checkmate, stalemate, insufficient material, fifty moves', () => {
    expect(gameOutcome(at('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'))).toBeNull();
    expect(gameOutcome(at('R5k1/5ppp/8/8/8/8/8/6K1 b - - 1 1'))).toEqual({
      result: '1-0',
      reason: 'checkmate',
    });
    expect(gameOutcome(at('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'))).toEqual({
      result: '½-½',
      reason: 'stalemate',
    });
    expect(gameOutcome(at('7k/8/8/8/8/8/8/K7 w - - 0 1'))?.reason).toBe('insufficient_material');
    expect(gameOutcome(at('7k/8/8/8/8/8/8/KR6 w - - 100 80'))?.reason).toBe('fifty_moves');
  });

  it('counts repetitions over the move list and looks at the tip', () => {
    const s = useGameStore.getState();
    s.loadPgn('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8');
    expect(gameOutcome(useGameStore.getState())?.reason).toBe('threefold_repetition');
    s.goTo(2);
    expect(gameOutcome(useGameStore.getState())?.reason).toBe('threefold_repetition');
    s.loadPgn('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6');
    expect(gameOutcome(useGameStore.getState())).toBeNull();
  });
});

describe('strength', () => {
  it('maps presets to UCI options', () => {
    expect(STRENGTH_PRESETS.map((p) => p.elo ?? 'full')).toEqual([
      1350,
      1500,
      1800,
      2100,
      2400,
      2800,
      'full',
    ]);
    expect(strengthOptions(findStrength('2100'))).toEqual({
      UCI_LimitStrength: true,
      UCI_Elo: 2100,
    });
    expect(strengthOptions(findStrength('full'))).toEqual({ UCI_LimitStrength: false });
    expect(strengthOptions({ id: 'x', label: 'x', elo: 9999 })).toEqual({
      UCI_LimitStrength: true,
      UCI_Elo: MAX_UCI_ELO,
    });
    expect(strengthOptions({ id: 'x', label: 'x', elo: 100 }).UCI_Elo).toBe(1320);
    expect(findStrength('nope').id).toBe('1500');
  });
});
