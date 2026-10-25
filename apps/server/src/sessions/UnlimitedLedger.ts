import type { SessionLedger } from './ClientSessions.js';

/**
 * A {@link SessionLedger} that never refuses (ADR-020 relay layering §4/§5). Used where per-IP
 * accounting happens elsewhere or cannot happen: on a node (it never sees client addresses; the
 * node-wide cap is the pool's `maxSessions`, answered `no_capacity` by `acquire`) and for the
 * hub's built-in node (the hub's `AccountingChannel` counts per IP and per token).
 */
export class UnlimitedLedger implements SessionLedger {
  readonly maxPerIp = Number.POSITIVE_INFINITY;
  private held = 0;

  tryReserve(): boolean {
    this.held++;
    return true;
  }

  release(): void {
    if (this.held > 0) this.held--;
  }

  /** Slots currently held (informational). */
  get total(): number {
    return this.held;
  }
}
