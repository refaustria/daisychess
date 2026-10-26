import { create } from 'zustand';

/**
 * "Resign this game?" confirmation of a live game, shared by the Live panel and the phone action
 * bar (M29-6) so that either one can ask and answer it.
 */
export const useResignConfirm = create<{ open: boolean }>()(() => ({ open: false }));

export const setResignConfirm = (open: boolean): void => useResignConfirm.setState({ open });
