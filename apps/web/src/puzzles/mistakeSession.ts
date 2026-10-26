import { create } from 'zustand';
import type { MistakeRecord } from './mistakeStore';

/**
 * "Train due" session of the Your mistakes panel. Module-level so that leaving the mode mid
 * training does not drop the queue: the panel resumes at "Puzzle i of n".
 */
export interface MistakeSessionState {
  /** Puzzles still to come after the current one. */
  queue: MistakeRecord[];
  index: number;
  total: number;
  active: boolean;
  /** Short note of the panel ("Nothing is due right now."); cleared by the next action. */
  note?: string | undefined;
}

const IDLE: MistakeSessionState = { queue: [], index: 0, total: 0, active: false };

export const useMistakeSession = create<MistakeSessionState>()(() => IDLE);

export const resetMistakeSession = (): void => useMistakeSession.setState(IDLE, true);

export const setMistakeNote = (note: string | undefined): void =>
  useMistakeSession.setState({ note });
