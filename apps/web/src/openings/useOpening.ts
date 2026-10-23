import { useEffect, useSyncExternalStore } from 'react';
import { useGameStore } from '../store/gameStore';
import { loadOpenings, onOpeningsLoaded, openingForGame, openingsLoaded, type Opening } from '.';

/** Opening as of the current ply; triggers the lazy load of the table. */
export function useOpening(): Opening | null {
  const startFen = useGameStore((s) => s.startFen);
  const moves = useGameStore((s) => s.moves);
  const ply = useGameStore((s) => s.ply);
  useSyncExternalStore(onOpeningsLoaded, openingsLoaded);
  useEffect(() => {
    void loadOpenings();
  }, []);
  return openingForGame({ startFen, moves, ply });
}
