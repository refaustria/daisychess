import { useEffect, useRef } from 'react';
import type { ServerProbeState } from '../engine/registry';
import { useAnalysisStore } from '../store/analysisStore';
import { useSettingsStore } from '../store/settingsStore';
import { requestHumanProbe } from './opponentProbe';

/**
 * The server probe (cached by the analysis store) that decides whether Maia can be chosen
 * (`opponentAvailability.ts`). Requested while `active` (a setup form is shown), again after the
 * probe was reset (new server URL) and, ignoring the cache, when the access token changes.
 */
export function useHumanProbe(active = true): ServerProbeState {
  const probe = useAnalysisStore((s) => s.serverProbe);
  const token = useSettingsStore((s) => s.serverToken);
  const lastToken = useRef(token);
  const idle = probe.status === 'idle';
  useEffect(() => {
    if (!active) return;
    const changed = lastToken.current !== token;
    lastToken.current = token;
    requestHumanProbe(changed);
  }, [active, idle, token]);
  return probe;
}
