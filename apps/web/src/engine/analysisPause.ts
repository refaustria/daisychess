import { useAnalysisStore } from '../store/analysisStore';

/*
 * Live analysis off while a training session runs (openings drill, puzzles: no best-move arrow
 * while the user is asked to find the move), restored afterwards (ADR-023 §6).
 *
 * Several holders may pause at the same time; the analysis is switched back on when the last
 * holder releases, and only if a pause switched it off (or the user tried to switch it on while
 * a holder was active).
 */

interface Holder {
  active: () => boolean;
}

const holders = new Set<Holder>();
let suspended = false;
let unwatch: (() => void) | null = null;

function anyActive(): boolean {
  for (const h of holders) if (h.active()) return true;
  return false;
}

/**
 * Switches the live analysis off and keeps it off while `active()` is true (an attempt to switch
 * it on is reverted). Returns the release function (idempotent): the last release restores the
 * analysis if a pause had switched it off.
 */
export function pauseAnalysis(active: () => boolean): () => void {
  const holder: Holder = { active };
  holders.add(holder);
  const a = useAnalysisStore.getState();
  if (a.enabled) {
    a.setEnabled(false);
    suspended = true;
  }
  unwatch ??= useAnalysisStore.subscribe((s) => {
    if (s.enabled && anyActive()) {
      suspended = true;
      s.setEnabled(false);
    }
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders.delete(holder);
    if (holders.size > 0) return;
    unwatch?.();
    unwatch = null;
    if (!suspended) return;
    suspended = false;
    if (!useAnalysisStore.getState().enabled) useAnalysisStore.getState().setEnabled(true);
  };
}

/** True while at least one pause is held. */
export function analysisPaused(): boolean {
  return holders.size > 0;
}

/** Test seam: drops every holder without touching the analysis store. */
export function resetAnalysisPause(): void {
  holders.clear();
  unwatch?.();
  unwatch = null;
  suspended = false;
}
