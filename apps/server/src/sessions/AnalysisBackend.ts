import type { EngineInfo, ProtocolErrorCode } from '@daisychess/engine-core';
import type { ExitInfo, GoParams, SearchResult, UciOptions } from '../engines/UciProcess.js';

/**
 * The engine operations a session needs from a leased engine (a subset of `UciProcess`).
 * `LocalBackend` hands out real processes; other backends (M24-5) can implement it remotely.
 */
export interface BackendEngine {
  /** OS process id, for logs only; undefined when not applicable. */
  readonly pid: number | undefined;
  /** Applies allow-listed UCI options (waits for `readyok`). Rejects when the engine is gone. */
  setOptions(options: UciOptions): Promise<void>;
  /** Sets the position for the next `go`. Throws synchronously when the engine is gone. */
  position(fen: string): void;
  /**
   * Starts a search. Resolves with the engine's `bestmove`; rejects when the engine exits.
   * `onInfo` is called for every parsed `info` line until then.
   */
  go(params: GoParams, onInfo: (info: EngineInfo) => void): Promise<SearchResult>;
  /** Asks the running search to stop; its `go()` promise then resolves. */
  stop(): Promise<SearchResult | null>;
  /** Subscribes to the engine's (unexpected or final) exit; returns the unsubscribe function. */
  onExit(cb: (exit: ExitInfo) => void): () => void;
}

/** One engine leased to one session until {@link AnalysisBackend.release}. */
export interface BackendLease {
  readonly id: number;
  readonly engineId: string;
  readonly engine: BackendEngine;
  readonly released: boolean;
}

/** Who asks for an engine (informational: logs, per-peer accounting in remote backends). */
export interface AcquireOptions {
  /** `SessionPeer.id` of the asking client. */
  peerId: number | string;
  /** Client-chosen session id (scoped to the peer). */
  sessionId: string;
}

export type BackendAcquireResult =
  | { ok: true; lease: BackendLease }
  | {
      ok: false;
      code: Extract<ProtocolErrorCode, 'unknown_engine' | 'no_capacity' | 'internal_error'>;
      message: string;
    };

export interface BackendHealth {
  /** False when the backend cannot serve new leases (shut down, node offline). */
  available: boolean;
  /** Leases currently held through this backend. */
  sessions: number;
}

/**
 * Where a session's engines come from (ADR-020 §8). `acquire` never throws; `release` is
 * idempotent and settles once the engine is reusable (or was discarded).
 */
export interface AnalysisBackend {
  acquire(engineId: string, opts: AcquireOptions): Promise<BackendAcquireResult>;
  release(lease: BackendLease): Promise<void>;
  /** The leased engine completed a search (`bestmove`), which proves it healthy. */
  reportHealthy(lease: BackendLease): void;
  health(): BackendHealth;
}
