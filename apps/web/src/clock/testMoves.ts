import { Chess } from 'chess.js';
import { START_FEN, type MoveClock, type MoveRecord } from '../store/gameStore';

/** Test helper: move records for `sans` with the given clock data per ply. */
export function timedMoves(sans: string[], clocks: (MoveClock | undefined)[], fen = START_FEN): MoveRecord[] {
  const c = new Chess(fen);
  return sans.map((san, i) => {
    const m = c.move(san);
    const clock = clocks[i];
    return { san: m.san, from: m.from, to: m.to, fen: c.fen(), ...(clock ? { clock } : {}) };
  });
}
