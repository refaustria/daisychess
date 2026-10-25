import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  findOpening,
  getBook,
  loadOpenings,
  onOpeningsLoaded,
  openingsLoaded,
  toEpd,
} from '../openings';
import { START_FEN, useGameStore } from '../store/gameStore';
import { computeOpeningFocus, type OpeningFocus } from './openingFocus';
import { useReviewStore } from './reviewStore';

/**
 * The opening focus of the game on the board (M18-3), with the eval swing from the current
 * review. Null for a custom start position, a game without moves, or while the book loads
 * (the hook triggers the lazy load).
 */
export function useOpeningFocus(): OpeningFocus | null {
  const startFen = useGameStore((s) => s.startFen);
  const moves = useGameStore((s) => s.moves);
  const details = useReviewStore((s) => s.moveDetails);
  const loaded = useSyncExternalStore(onOpeningsLoaded, openingsLoaded);
  useEffect(() => {
    void loadOpenings();
  }, []);
  return useMemo(() => {
    const book = getBook();
    if (!loaded || !book || startFen !== START_FEN || moves.length === 0) return null;
    return computeOpeningFocus({
      sans: moves.map((m) => m.san),
      epds: [toEpd(startFen), ...moves.map((m) => toEpd(m.fen))],
      book,
      findOpening,
      details,
    });
  }, [loaded, startFen, moves, details]);
}
