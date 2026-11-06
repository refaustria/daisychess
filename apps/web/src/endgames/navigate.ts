/**
 * Small entry points of the endgame trainer for the main chunk (ADR-025 §6): opening the
 * Endgames tab on a lesson group (the tour's "Train this endgame") and stopping a running
 * lesson from the other trainers (puzzles, openings drill) without importing the lesson store,
 * which would make those modules depend on each other.
 */
import type { LessonGroup } from '@daisychess/endgames';
import { create } from 'zustand';
import { useUiStore } from '../store/uiStore';

export interface EndgamesNav {
  /** The group the course list should show (null: no request pending). */
  group: LessonGroup | null;
  /** Bumped by every {@link openEndgames} call (the panel reacts to repeated requests). */
  seq: number;
}

export const useEndgamesNav = create<EndgamesNav>()(() => ({ group: null, seq: 0 }));

/** Shows the Endgames tab, optionally on the course group `group`. */
export function openEndgames(group?: LessonGroup): void {
  useEndgamesNav.setState((s) => ({ group: group ?? null, seq: s.seq + 1 }));
  useUiStore.getState().setActiveTab('endgames');
}

/** The panel has consumed the group request. */
export function clearEndgamesGroup(): void {
  if (useEndgamesNav.getState().group !== null) useEndgamesNav.setState({ group: null });
}

let stopper: (() => void) | null = null;

/** The lesson store registers its `stop` here; returns the unregister function. */
export function registerLessonStop(fn: () => void): () => void {
  stopper = fn;
  return () => {
    if (stopper === fn) stopper = null;
  };
}

/** Ends a running endgame lesson silently (no-op while the trainer was never loaded). */
export function stopEndgameLesson(): void {
  stopper?.();
}
