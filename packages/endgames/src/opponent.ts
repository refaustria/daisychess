import { Chess } from 'chess.js';
import { keepers, rankMoves } from './tablebase/judge.js';
import type { TablebaseProbe, TbPosition } from './tablebase/types.js';

/**
 * Policies of the trainer's perfect opponent (ADR-025 §6):
 * - `dtz`: lichess's best-first ordering (`rankMoves`): fastest win, slowest loss, zeroing
 *   draws first — for sources with DTZ (the API, local WDL+DTZ tables);
 * - `wdlTrappy`: for WDL-only tables: among the result-keeping moves, the one after which the
 *   user has the fewest result-keeping replies (1-ply lookahead, one probe per candidate).
 */
export type OpponentPolicy = 'dtz' | 'wdlTrappy';

/** The position after `uci` in `fen` (chess.js), or undefined when the move is illegal. */
export function fenAfter(fen: string, uci: string): string | undefined {
  try {
    const chess = new Chess(fen);
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return chess.fen();
  } catch {
    return undefined;
  }
}

const byUci = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The opponent's move (UCI) in `pos` (the opponent to move). Deterministic: never changes the
 * theoretical result; ties are broken by UCI order. `wdlTrappy` probes each result-keeping
 * candidate's child position; candidates whose child cannot be probed rank last, and when no
 * child can be probed the `dtz` choice is returned. Rejects when the position has no moves.
 */
export async function opponentMove(
  pos: TbPosition,
  probe: TablebaseProbe,
  policy: OpponentPolicy,
): Promise<string> {
  const ranked = rankMoves(pos);
  const best = ranked[0];
  if (!best) throw new Error('opponentMove: no legal moves');
  if (policy === 'dtz') return best.uci;

  const candidates = keepers(pos)
    .map((m) => m.uci)
    .sort(byUci);
  let choice: string | undefined;
  let fewest = Infinity;
  for (const uci of candidates) {
    const child = fenAfter(pos.fen, uci);
    const childPos = child === undefined ? null : await probe.probe(child);
    if (!childPos) continue;
    // A mate or stalemate leaves the user no reply at all: 0 keepers.
    const userKeepers = childPos.moves.length === 0 ? 0 : keepers(childPos).length;
    if (userKeepers < fewest) {
      fewest = userKeepers;
      choice = uci;
    }
  }
  return choice ?? best.uci;
}
