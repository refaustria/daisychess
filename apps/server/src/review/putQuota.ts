/**
 * Per-address daily allowance of review writes (ADR-017, env `REVIEW_PUT_PER_IP_PER_DAY`): every
 * `review.put` and `review.positions.put` counts one. In memory per process (a restart resets it);
 * days are UTC.
 */
export class PutQuota {
  private readonly counts = new Map<string, { day: number; count: number }>();

  constructor(
    readonly perDay: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Consumes one write of `ip` if the allowance is not used up; false when it is. */
  take(ip: string): boolean {
    const day = Math.floor(this.now() / 86_400_000);
    let entry = this.counts.get(ip);
    if (!entry || entry.day !== day) {
      if (this.counts.size >= 10_000) this.prune(day);
      entry = { day, count: 0 };
      this.counts.set(ip, entry);
    }
    if (entry.count >= this.perDay) return false;
    entry.count++;
    return true;
  }

  /** Writes consumed today by `ip`. */
  used(ip: string): number {
    const entry = this.counts.get(ip);
    return entry && entry.day === Math.floor(this.now() / 86_400_000) ? entry.count : 0;
  }

  get addresses(): number {
    return this.counts.size;
  }

  private prune(day: number): void {
    for (const [ip, e] of this.counts) if (e.day !== day) this.counts.delete(ip);
  }
}
