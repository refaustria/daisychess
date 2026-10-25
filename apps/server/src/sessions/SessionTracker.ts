import type {
  AnalyzeMessage,
  BestMoveMessage,
  ErrorMessage,
  InfoMessage,
  ReleaseMessage,
  StopMessage,
} from '@daisychess/engine-core';

export type TrackerEvent =
  | { kind: 'session_opened' | 'session_closed'; sessionId: string }
  | {
      kind: 'search_started' | 'search_ended';
      sessionId: string;
      searchId: number;
      startedAt: number;
      endedAt?: number;
    };

/** An accepted-or-pending search that has not seen its terminal message yet. */
export interface OpenSearch {
  sessionId: string;
  searchId: number;
  startedAt: number;
}

/**
 * Message-derived session/search bookkeeping of one player connection (ADR-020 relay layering
 * §3/§4), pure: no timers, no I/O. Fed with the client's messages ({@link in}) and the server's
 * answers ({@link out}), it reports what opened and closed:
 *
 * - `analyze` opens its session (first time) and starts the search `(sessionId, searchId)`.
 * - `bestmove`, or an `error` carrying `searchId`, ends that search (the terminal message).
 * - An `error` with `sessionId` but no `searchId` closes the session (session-level failure).
 * - `release` closes the session. Its open searches stay tracked until their terminal arrives
 *   (the engine side still sends `bestmove stopped`), so {@link openSearchList} names exactly the
 *   searches still owed a terminal message.
 * - `stop` and `info` change nothing.
 *
 * A terminal for a search that is not tracked (never started, already ended, or a duplicate) is
 * ignored. Searches are keyed by `(sessionId, searchId)`; a session reopened after `release`
 * keeps the old session's unfinished searches.
 */
export class SessionTracker {
  private readonly sessions = new Set<string>();
  /** sessionId → searchId → startedAt. */
  private readonly searches = new Map<string, Map<number, number>>();

  constructor(private readonly now: () => number = Date.now) {}

  in(msg: AnalyzeMessage | StopMessage | ReleaseMessage): TrackerEvent[] {
    const { sessionId } = msg;
    switch (msg.type) {
      case 'analyze': {
        const events: TrackerEvent[] = [];
        if (!this.sessions.has(sessionId)) {
          this.sessions.add(sessionId);
          events.push({ kind: 'session_opened', sessionId });
        }
        let byId = this.searches.get(sessionId);
        if (!byId) {
          byId = new Map();
          this.searches.set(sessionId, byId);
        }
        if (!byId.has(msg.searchId)) {
          const startedAt = this.now();
          byId.set(msg.searchId, startedAt);
          events.push({ kind: 'search_started', sessionId, searchId: msg.searchId, startedAt });
        }
        return events;
      }
      case 'release':
        return this.closeSession(sessionId);
      case 'stop':
        return [];
    }
  }

  out(msg: InfoMessage | BestMoveMessage | ErrorMessage): TrackerEvent[] {
    if (msg.type === 'info') return [];
    const { sessionId } = msg;
    if (sessionId === undefined) return [];
    if (msg.searchId === undefined) return this.closeSession(sessionId);
    return this.endSearch(sessionId, msg.searchId);
  }

  /** Open sessions in opening order. */
  get openSessions(): readonly string[] {
    return [...this.sessions];
  }

  /** Searches of `sessionId` still waiting for their terminal (also after `release`). */
  openSearches(sessionId: string): readonly number[] {
    return [...(this.searches.get(sessionId)?.keys() ?? [])];
  }

  /** Every search still waiting for its terminal, across all sessions (open or released). */
  openSearchList(): readonly OpenSearch[] {
    const out: OpenSearch[] = [];
    for (const [sessionId, byId] of this.searches) {
      for (const [searchId, startedAt] of byId) out.push({ sessionId, searchId, startedAt });
    }
    return out;
  }

  /** Number of searches still waiting for their terminal. */
  get openSearchCount(): number {
    let n = 0;
    for (const byId of this.searches.values()) n += byId.size;
    return n;
  }

  private closeSession(sessionId: string): TrackerEvent[] {
    if (!this.sessions.delete(sessionId)) return [];
    return [{ kind: 'session_closed', sessionId }];
  }

  private endSearch(sessionId: string, searchId: number): TrackerEvent[] {
    const byId = this.searches.get(sessionId);
    const startedAt = byId?.get(searchId);
    if (!byId || startedAt === undefined) return [];
    byId.delete(searchId);
    if (byId.size === 0) this.searches.delete(sessionId);
    return [{ kind: 'search_ended', sessionId, searchId, startedAt, endedAt: this.now() }];
  }
}
