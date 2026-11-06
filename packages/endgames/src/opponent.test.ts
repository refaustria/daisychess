import { describe, expect, it, vi } from 'vitest';
import { fenAfter, opponentMove } from './opponent.js';
import type { TablebaseProbe, TbCategory, TbMove, TbPosition } from './tablebase/types.js';

/** K+R vs K, Black (the defender) to move: eight king moves. */
const FEN = '8/8/8/4k3/8/8/8/R3K3 b - - 0 1';
const KING_MOVES = ['e5d4', 'e5d5', 'e5d6', 'e5e4', 'e5e6', 'e5f4', 'e5f5', 'e5f6'];

const mv = (uci: string, category: TbCategory, extra: Partial<TbMove> = {}): TbMove => ({
  uci,
  san: uci,
  category,
  zeroing: false,
  checkmate: false,
  stalemate: false,
  ...extra,
});

/** Black loses after every move; DTZ (White's view after the move) per move. */
function defenderPos(dtz: Record<string, number>): TbPosition {
  return {
    fen: FEN,
    category: 'loss',
    moves: KING_MOVES.map((u) => mv(u, 'win', { dtz: dtz[u] ?? 10 })),
  };
}

/** A fake probe: the child of each candidate has `n` keepers for White (the user). */
function fakeProbe(keepersAfter: Record<string, number | null>): TablebaseProbe & {
  probe: ReturnType<typeof vi.fn>;
} {
  const byFen = new Map<string, TbPosition | null>();
  for (const [uci, n] of Object.entries(keepersAfter)) {
    const fen = fenAfter(FEN, uci)!;
    byFen.set(
      fen,
      n === null
        ? null
        : {
            fen,
            category: 'win',
            moves: [
              ...Array.from({ length: n }, (_, i) => mv(`a1a${i + 2}`, 'loss')),
              mv('a1h1', 'draw'),
            ],
          },
    );
  }
  return { probe: vi.fn(async (fen: string) => byFen.get(fen) ?? null) };
}

describe('fenAfter', () => {
  it('plays a legal move and rejects an illegal one', () => {
    expect(fenAfter(FEN, 'e5d4')).toBe('8/8/8/8/3k4/8/8/R3K3 w - - 1 2');
    expect(fenAfter(FEN, 'e5e3')).toBeUndefined(); // two squares
    expect(fenAfter(FEN, 'a1a2')).toBeUndefined(); // not Black's piece
    expect(fenAfter('nonsense', 'e2e4')).toBeUndefined();
  });

  it('handles promotions', () => {
    expect(fenAfter('8/1P6/8/8/8/8/8/k1K5 w - - 0 1', 'b7b8q')).toBe(
      '1Q6/8/8/8/8/8/8/k1K5 b - - 0 1',
    );
  });
});

describe('opponentMove', () => {
  it('dtz: the slowest loss for a losing defender, ties by UCI', async () => {
    const probe = fakeProbe({});
    const pos = defenderPos({ e5d6: 25, e5f6: 25, e5e4: 3 });
    expect(await opponentMove(pos, probe, 'dtz')).toBe('e5d6');
    expect(probe.probe).not.toHaveBeenCalled();
  });

  it('dtz: never changes the result even when a losing move is slower', async () => {
    const pos: TbPosition = {
      fen: FEN,
      category: 'draw',
      moves: [
        mv('e5d4', 'win', { dtz: 90 }),
        mv('e5f6', 'draw'),
        mv('e5d6', 'draw', { zeroing: true }),
      ],
    };
    expect(await opponentMove(pos, fakeProbe({}), 'dtz')).toBe('e5d6');
  });

  it('dtz: the fastest win for an attacker', async () => {
    const pos: TbPosition = {
      fen: FEN,
      category: 'win',
      moves: [mv('e5d4', 'loss', { dtz: -9 }), mv('e5f6', 'loss', { dtz: -2 }), mv('e5d6', 'draw')],
    };
    expect(await opponentMove(pos, fakeProbe({}), 'dtz')).toBe('e5f6');
  });

  it('wdlTrappy: the move leaving the user the fewest keepers', async () => {
    const counts = { e5d4: 4, e5d5: 3, e5d6: 5, e5e4: 2, e5e6: 6, e5f4: 3, e5f5: 4, e5f6: 2 };
    const probe = fakeProbe(counts);
    const pos = defenderPos({ e5d6: 30 });
    // e5e4 and e5f6 both leave 2: UCI order.
    expect(await opponentMove(pos, probe, 'wdlTrappy')).toBe('e5e4');
    expect(probe.probe).toHaveBeenCalledTimes(8);
  });

  it('wdlTrappy: only result-keeping candidates are considered', async () => {
    const pos: TbPosition = {
      fen: FEN,
      category: 'draw',
      moves: [mv('e5d4', 'win'), mv('e5f6', 'draw'), mv('e5d6', 'draw')],
    };
    // e5d4 would leave 0 keepers but loses: not a candidate, never probed.
    const probe = fakeProbe({ e5d4: 0, e5f6: 3, e5d6: 1 });
    expect(await opponentMove(pos, probe, 'wdlTrappy')).toBe('e5d6');
    expect(probe.probe).toHaveBeenCalledTimes(2);
  });

  it('wdlTrappy: skips unprobeable children and falls back to dtz when none answers', async () => {
    const pos = defenderPos({ e5f5: 40 });
    const some = fakeProbe({ e5d4: null, e5d5: 7, e5f6: 7 });
    expect(await opponentMove(pos, some, 'wdlTrappy')).toBe('e5d5');
    expect(await opponentMove(pos, fakeProbe({}), 'wdlTrappy')).toBe('e5f5');
  });

  it('wdlTrappy: a mating or stalemating child counts as zero keepers', async () => {
    const pos = defenderPos({});
    const fenD4 = fenAfter(FEN, 'e5d4')!;
    const probe: TablebaseProbe = {
      probe: async (fen) =>
        fen === fenD4
          ? { fen, category: 'loss', moves: [] }
          : { fen, category: 'win', moves: [mv('a1a2', 'loss')] },
    };
    expect(await opponentMove(pos, probe, 'wdlTrappy')).toBe('e5d4');
  });

  it('rejects a position without moves', async () => {
    await expect(
      opponentMove({ fen: FEN, category: 'loss', moves: [] }, fakeProbe({}), 'dtz'),
    ).rejects.toThrow(/no legal moves/);
  });
});
