export interface RateLimit {
  max: number;
  windowMs: number;
}

/**
 * Sliding-window check: records an event at `now` and returns true unless `limit.max` events
 * already happened within the last `limit.windowMs`. `times` is the caller's event log.
 */
export function allowRate(times: number[], limit: RateLimit, now: number = Date.now()): boolean {
  while (times.length > 0 && now - times[0]! >= limit.windowMs) times.shift();
  if (times.length >= limit.max) return false;
  times.push(now);
  return true;
}
