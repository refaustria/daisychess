import type { EngineDescriptor } from '@daisychess/engine-core';
import type { ServerProbeState } from '../engine/registry';
import { authMessage, isAuthError } from '../server/tokenMessages';
import { SERVER_UNAVAILABLE_MESSAGE } from './opponent';

/**
 * Whether the human-like opponents (Maia on the engine server, ADR-019) can be chosen, derived
 * from the analysis store's cached server probe (`serverProbe`, one short connection with the
 * Settings token):
 *
 * - probe ok + `welcome.engines` lists enabled `style: 'human'` engines → available (per level:
 *   the engine `maia-<rating>` must be listed and enabled);
 * - the server answered with a restricted welcome (token missing/wrong) → "No server access token on
 *   this device" or "Server access token was rejected" (see server/tokenMessages);
 * - any other failure → "Server unavailable"; no human engines → "Not offered by the server";
 * - not probed yet / probing → `pending` (the panel probes on mount; a start is not refused).
 */
export type HumanAvailability =
  | { ok: true; engines: readonly EngineDescriptor[] }
  | { ok: false; reason: string; pending?: true };

export const CHECKING_SERVER_MESSAGE = 'Checking the server…';
export const NOT_OFFERED_MESSAGE = 'Not offered by the server';

/** Human-like engines of a probe (enabled ones only). */
export const humanEngines = (engines: readonly EngineDescriptor[] | undefined) =>
  (engines ?? []).filter((e) => e.style === 'human' && e.enabled);

export function humanAvailability(probe: ServerProbeState): HumanAvailability {
  if (probe.status === 'ok') {
    const engines = humanEngines(probe.engines);
    return engines.length > 0 ? { ok: true, engines } : { ok: false, reason: NOT_OFFERED_MESSAGE };
  }
  if (probe.status === 'error') {
    return {
      ok: false,
      reason: isAuthError(probe.error)
        ? authMessage()
        : SERVER_UNAVAILABLE_MESSAGE,
    };
  }
  return { ok: false, reason: CHECKING_SERVER_MESSAGE, pending: true };
}

/**
 * Why the engine `engineId` cannot be chosen, or undefined when it can. `pending` probes give
 * {@link CHECKING_SERVER_MESSAGE}.
 */
export function humanEngineReason(probe: ServerProbeState, engineId: string): string | undefined {
  const a = humanAvailability(probe);
  if (!a.ok) return a.reason;
  return a.engines.some((e) => e.id === engineId) ? undefined : NOT_OFFERED_MESSAGE;
}

/**
 * Like {@link humanEngineReason}, but a probe that has not finished yet does not block: the
 * game starts and the opponent's own connection reports the failure (used by `start`).
 */
export function humanStartRefusal(probe: ServerProbeState, engineId: string): string | undefined {
  if (probe.status !== 'ok' && probe.status !== 'error') return undefined;
  return humanEngineReason(probe, engineId);
}
