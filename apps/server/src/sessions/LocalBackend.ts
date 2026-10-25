import type { EnginePool, Lease } from '../engines/EnginePool.js';
import type {
  AnalysisBackend,
  BackendAcquireResult,
  BackendHealth,
  BackendLease,
} from './AnalysisBackend.js';

/** {@link AnalysisBackend} over this process's own {@link EnginePool} (standalone / node `local`). */
export class LocalBackend implements AnalysisBackend {
  constructor(readonly pool: EnginePool) {}

  /** Peer/session ids (`AcquireOptions`) are not needed locally: the pool accounts globally. */
  readonly acquire: AnalysisBackend['acquire'] = (engineId): Promise<BackendAcquireResult> =>
    this.pool.acquire(engineId);

  release(lease: BackendLease): Promise<void> {
    // Leases handed out by this backend are pool leases; the pool ignores foreign objects.
    return this.pool.release(lease as Lease);
  }

  reportHealthy(lease: BackendLease): void {
    this.pool.reportHealthy(lease as Lease);
  }

  health(): BackendHealth {
    return { available: !this.pool.isClosed, sessions: this.pool.sessions };
  }
}
