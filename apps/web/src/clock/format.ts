/** Below this the clock turns to the low-time colour (also capped by 10 % of the initial time). */
export const LOW_TIME_MS = 20_000;

/** Formats clock time: m:ss, tenths below 10 s (`0:09.8`), h:mm:ss from an hour. */
export function formatClock(ms: number): string {
  const t = Math.max(0, ms);
  if (t < 10_000) {
    const tenths = Math.floor(t / 100);
    return `0:0${Math.floor(tenths / 10)}.${tenths % 10}`;
  }
  const secs = Math.floor(t / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = String(secs % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Low time: under 20 s, and for short games under 10 % of the initial time, whichever is
 * smaller (a 1+0 game turns red at 6 s, a 15-second game is not red from the first move).
 */
export function isLowTime(ms: number, initialMs?: number): boolean {
  const limit = initialMs && initialMs > 0 ? Math.min(LOW_TIME_MS, initialMs * 0.1) : LOW_TIME_MS;
  return ms < limit;
}
