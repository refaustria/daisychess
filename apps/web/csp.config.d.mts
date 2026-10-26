export function inlineScriptHashes(html: string): string[];
export function buildCsp(extraConnect?: string[]): string;
export const PRODUCTION_CSP: string;
export function metaCsp(policy?: string): string;
/** `wss:`, added to connect-src of the mobile meta policy (self-hosted hubs, M26-3). */
export const MOBILE_HUB_SOURCE: string;
export function mobileMetaCsp(env?: Record<string, string | undefined>): string;
export const CSP_REPORT_FILE: string;
export const APP_HOST: string;
export const HUB_CSP: string;
