/**
 * Trigger of the server probe that tells the Play/Openings panels whether Maia is available
 * (`opponentAvailability.ts`). Kept free of store imports so the unit-test setup can replace it
 * without loading the stores.
 */
let probeFn: (force: boolean) => void = (force) => {
  void import('../store/analysisStore').then(({ useAnalysisStore }) =>
    useAnalysisStore.getState().probeServer({ force }),
  );
};

/**
 * Asks for a fresh-enough server probe (cached by the analysis store); `force` ignores the
 * cache (the access token changed).
 */
export function requestHumanProbe(force = false): void {
  probeFn(force);
}

/** Test seam: replaces the probe trigger (unit tests have no engine server). */
export function setHumanProbe(fn: (force: boolean) => void): void {
  probeFn = fn;
}
