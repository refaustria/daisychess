import {
  fallbackEloText,
  fallbackEloTooltip,
  maiaEloBand,
  maiaEloShort,
  maiaEloTooltip,
  useEloView,
  type EloView,
  type Side,
} from '../../maia/eloEstimate';
import styles from './ReviewPanel.module.css';

/**
 * The Elo estimate line under a side's accuracy (ADR-024 §5): "played like ~1540 here" with the
 * band (Maia), "played like ≈ 1500 ± 300 here, approximate" (fallback, muted while the Maia run
 * is pending with "Estimating… (12 of 18)"), "<1100" / ">1900" at the grid edges; nothing for a
 * side with too few positions or for the engine's side. The tooltip explains the method.
 */
export function EloLine({ side }: { side: Side }) {
  const view = useEloView(side);
  return <EloLineView side={side} view={view} />;
}

/** Presentational part (tests render it with a fixed view). */
export function EloLineView({ side, view }: { side: Side; view: EloView | undefined }) {
  if (!view) return null;
  if (view.maia) {
    const e = view.maia;
    const band = maiaEloBand(e);
    return (
      <p
        className={styles.elo}
        data-testid={`elo-${side}`}
        data-method="maia"
        title={maiaEloTooltip(e)}
      >
        played like <strong>{maiaEloShort(e)}</strong> here
        {band && <span className={styles.eloBand}> {band}</span>}
        {!e.exact && <span className={styles.eloBand}>, approximate</span>}
      </p>
    );
  }
  const f = view.fallback;
  if (!f) return null;
  return (
    <p
      className={view.pending ? `${styles.elo} ${styles.eloPending}` : styles.elo}
      data-testid={`elo-${side}`}
      data-method="fallback"
      title={fallbackEloTooltip(f)}
    >
      played like <strong>{fallbackEloText(f)}</strong> here
      <span className={styles.eloBand}>
        , approximate (from accuracy{f.provisional ? ', rough estimate' : ''})
      </span>
      {view.pending && (
        <span className={styles.eloStatus} data-testid={`elo-pending-${side}`}>
          {' '}
          Estimating… ({view.pending.done} of {view.pending.total})
        </span>
      )}
    </p>
  );
}
