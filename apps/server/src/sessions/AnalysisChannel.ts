import type { AnalyzeMessage, ReleaseMessage, StopMessage } from '@daisychess/engine-core';

/**
 * The analysis side of one player connection (ADR-020 relay layering §1): messages go in through
 * {@link handle}, results come out through the `deliver` callback the implementation was built
 * with. `ClientSessions` runs the sessions on engines (standalone, node, the hub's `local`);
 * `RelaySessions` (M24-5) relays them to a node over its link.
 */
export interface AnalysisChannel {
  /** Open sessions (for `/health` and tests). */
  readonly sessionCount: number;
  /** Dispatches one validated client message. Ignored after {@link close}. */
  handle(msg: AnalyzeMessage | StopMessage | ReleaseMessage): void;
  /** Fair play (ADR-013): drops every session. */
  retireAll(): void;
  /** Stops and releases everything; idempotent; nothing is delivered afterwards. */
  close(): Promise<void>;
  /**
   * Resolves once when the channel died underneath its connection (the node was lost or refused
   * the client, ADR-020 §3) after the terminal messages were delivered; the `Connection` then
   * closes the socket with 1012. Absent for channels that cannot be lost (local engines).
   */
  readonly lost?: Promise<void>;
}
