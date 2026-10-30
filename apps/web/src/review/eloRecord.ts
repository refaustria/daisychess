/**
 * Writes a finished Maia Elo estimate into the stored review record (ADR-024 §5): the local
 * cache record first, then — on a connection that may write (token) — the same record again with
 * `review.put` (same preset replaces the server's row; an older server strips the field, which is
 * harmless). Best effort: a missing local record (custom review budget, cache cleared) stores
 * nothing, and every failure is swallowed.
 */
import { getStoredReview, putStoredReview, type StoredElo, type StoredReview } from './reviewCache';
import { useReviewStore } from './reviewStore';
import { storeServerReview } from './serverReviewStore';

export interface EloRecordResult {
  /** The local record now carries the estimate. */
  local: boolean;
  /** The server accepted the re-sent record. */
  server: boolean;
}

/** Merges `elo` into the record of `gameKey` (existing sides kept unless replaced). */
export async function writeEloRecord(gameKey: string, elo: StoredElo): Promise<EloRecordResult> {
  if (!elo.white && !elo.black) return { local: false, server: false };
  let record: StoredReview | undefined;
  try {
    record = await getStoredReview(gameKey);
  } catch {
    record = undefined;
  }
  if (!record || record.gameKey !== gameKey) return { local: false, server: false };
  const merged: StoredReview = { ...record, elo: { ...(record.elo ?? {}), ...elo } };
  await putStoredReview(merged);
  // The shown review is this record: it now carries the estimate (a later request skips the run).
  const shown = useReviewStore.getState().stored;
  if (shown && shown.createdAt === record.createdAt && shown.preset === record.preset) {
    useReviewStore.setState({ stored: { ...shown, elo: merged.elo } });
  }
  const server = await storeServerReview(merged).catch(() => false);
  return { local: true, server };
}
