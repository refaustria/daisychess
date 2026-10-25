/**
 * Client factory of the Maia review hints (M23-3), kept in a module without dependencies so the
 * unit-test setup can disable the server without loading the review stores.
 */
import type { CreateMaiaClient, HintRunOptions } from './hints';

export type HintTiming = Partial<Omit<HintRunOptions, 'createClient' | 'onHint' | 'signal'>>;

/** `undefined`: the default (the review's engine server, when one is configured). */
let factoryOverride: CreateMaiaClient | null | undefined;
let timing: HintTiming = {};

/**
 * Replaces the client factory (`null` = no server, nothing is ever queried; `undefined` restores
 * the default) and the runner's timing options (tests). Call `resetMaiaHints()` to drop what the
 * store already has.
 */
export function setMaiaHintClientFactory(
  factory: CreateMaiaClient | null | undefined,
  opts: HintTiming = {},
): void {
  factoryOverride = factory;
  timing = opts;
}

export const hintFactoryOverride = (): CreateMaiaClient | null | undefined => factoryOverride;
export const hintTiming = (): HintTiming => timing;
