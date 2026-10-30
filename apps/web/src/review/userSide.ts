/**
 * The user's side for the guided review (ADR-024 §2). Never asks: engine/room/live source or a
 * name match (puzzles module) -> the side the user stored in the game ledger -> the side at the
 * bottom of the board. {@link switchReviewSide} stores a corrected side in the ledger.
 */
import {
  getLedgerGame,
  ledgerHeaders,
  recordReviewedGame,
  setUserSide,
} from '../puzzles/gameLedger';
import { activeGameSources } from '../puzzles/installLedger';
import { gameUrl, knownNames, resolveUserSide, type Side } from '../puzzles/userSide';
import { useGameStore, type GameState } from '../store/gameStore';

export type ReviewGame = Pick<GameState, 'headers' | 'orientation'>;

/** Resolves the side to follow in the tour of `game` (reviewed under `gameKey`). */
export async function reviewUserSide(game: ReviewGame, gameKey: string): Promise<Side> {
  const resolved = resolveUserSide(game.headers, activeGameSources(game.headers), knownNames());
  if (resolved.userSide) return resolved.userSide;
  const stored = (await getLedgerGame(gameKey))?.userSide;
  return stored ?? game.orientation;
}

/**
 * Stores `side` as the user's side of the game (creating the ledger entry from the game on the
 * board when missing) and returns it.
 */
export async function switchReviewSide(gameKey: string, side: Side): Promise<Side> {
  if (!(await setUserSide(gameKey, side))) {
    const g = useGameStore.getState();
    await recordReviewedGame({
      gameKey,
      startFen: g.startFen,
      moves: g.moves.map((m) => m.san),
      headers: ledgerHeaders(g.headers, gameUrl(g.headers)),
      source: resolveUserSide(g.headers, activeGameSources(g.headers), []).source,
      userSide: side,
      reviewedAt: Date.now(),
    });
  }
  return side;
}
