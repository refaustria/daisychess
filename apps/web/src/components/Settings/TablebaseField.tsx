import { useEffect, useId, useState } from 'react';
import { resetEndgameProgress } from '../../endgames/endgamesProgress';
import { formatBytes, packSize } from '../../endgames/tablePacks';
import { useTablebaseStore } from '../../endgames/tablebaseStore';
import {
  TABLEBASE_SETTINGS,
  useSettingsStore,
  type TablebaseSetting,
} from '../../store/settingsStore';
import styles from './SettingsPanel.module.css';

export const TABLEBASE_LABEL: Record<TablebaseSetting, string> = {
  online: 'lichess (positions with up to 7 pieces are sent to tablebase.lichess.ovh)',
  local: 'On this device only',
  off: 'Off',
};

/** The size of the rook pack, from the manifest ("20.9 MB"). */
export const ROOK_PACK_SIZE = formatBytes(packSize('rook'));

/** Settings → Endgames: tablebase lookups and the rook endgames download (ADR-025 §2). */
function RookPack() {
  const pack = useTablebaseStore((s) => s.packs.rook);
  const download = useTablebaseStore((s) => s.downloadPack);
  const cancel = useTablebaseStore((s) => s.cancelDownload);
  const remove = useTablebaseStore((s) => s.deletePack);
  const refresh = useTablebaseStore((s) => s.refreshPacks);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const state = pack.status?.state ?? 'absent';
  const total = pack.status?.totalBytes ?? packSize('rook');
  const loaded = pack.progress?.loaded ?? pack.status?.storedBytes ?? 0;

  let text: string;
  if (pack.busy === 'download') {
    text = `Downloading… ${formatBytes(loaded)} of ${formatBytes(total)}`;
  } else if (pack.busy === 'delete') {
    text = 'Deleting…';
  } else if (state === 'ready') {
    text = `Downloaded (${formatBytes(total)}). Rook endgames work without a connection.`;
  } else if (state === 'partial') {
    text = `Partly downloaded (${formatBytes(loaded)} of ${formatBytes(total)}).`;
  } else {
    text = `Not downloaded. Rook endgames (Lucena, Philidor, Vancura) then need the lichess lookups.`;
  }

  return (
    <div className={styles.group} role="group" aria-label="Rook endgames offline">
      <span className={styles.legend}>Rook endgames offline: {ROOK_PACK_SIZE}</span>
      {pack.busy === 'download' && (
        <progress
          value={loaded}
          max={total}
          aria-label="Rook endgames download"
          data-testid="tb-pack-progress"
        />
      )}
      <div className={styles.tokenRow}>
        {pack.busy === 'download' ? (
          <button type="button" className={styles.reset} onClick={cancel}>
            Cancel download
          </button>
        ) : (
          state !== 'ready' && (
            <button
              type="button"
              className={styles.reset}
              disabled={pack.busy !== null}
              data-testid="tb-pack-download"
              onClick={() => void download('rook')}
            >
              {state === 'partial' ? 'Resume download' : `Download (${ROOK_PACK_SIZE})`}
            </button>
          )
        )}
        {state !== 'absent' && pack.busy === null && (
          <button
            type="button"
            className={styles.reset}
            data-testid="tb-pack-delete"
            onClick={() => void remove('rook')}
          >
            Delete
          </button>
        )}
      </div>
      <p className={styles.help} role="status" data-testid="tb-pack-status">
        {text}
      </p>
      {pack.error && (
        <p className={styles.help} role="alert" data-testid="tb-pack-error">
          {pack.error}
        </p>
      )}
    </div>
  );
}

export interface TablebaseFieldProps {
  /** "Reset endgame progress" (M32-8); default: clears `daisychess.endgames`. */
  onResetProgress?: () => void;
}

/** "Reset endgame progress" with a confirmation step (like the puzzle data reset). */
function ResetProgress({ onReset }: { onReset: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <>
      <div className={styles.tokenRow}>
        {confirming ? (
          <>
            <button
              type="button"
              className={styles.reset}
              data-testid="endgames-reset-confirm"
              onClick={() => {
                onReset();
                setConfirming(false);
                setDone(true);
              }}
            >
              Yes, reset
            </button>
            <button type="button" className={styles.reset} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className={styles.reset}
            data-testid="endgames-reset"
            onClick={() => {
              setConfirming(true);
              setDone(false);
            }}
          >
            Reset endgame progress
          </button>
        )}
      </div>
      <p className={styles.help} role="status">
        {confirming
          ? 'This clears the done marks and the repetition schedule of every endgame lesson. It cannot be undone.'
          : done
            ? 'Endgame progress was reset.'
            : 'Starts the endgame course over.'}
      </p>
    </>
  );
}

export function TablebaseField({ onResetProgress = resetEndgameProgress }: TablebaseFieldProps) {
  const value = useSettingsStore((s) => s.tablebase);
  const set = useSettingsStore((s) => s.set);
  const id = useId();
  return (
    <div className={styles.group} role="group" aria-labelledby={`${id}-legend`}>
      <span id={`${id}-legend`} className={styles.legend}>
        Endgames
      </span>
      <div role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`}>
        <span id={`${id}-label`} className={styles.field}>
          Tablebase lookups
        </span>
        {TABLEBASE_SETTINGS.map((t) => (
          <label key={t} className={styles.check}>
            <input
              type="radio"
              name={`${id}-tablebase`}
              value={t}
              checked={value === t}
              data-testid={`tablebase-${t}`}
              onChange={() => set({ tablebase: t })}
            />
            {TABLEBASE_LABEL[t]}
          </label>
        ))}
      </div>
      <p id={`${id}-help`} className={styles.help}>
        Exact results for endgames with up to 7 pieces in the analysis, the review and the lessons.
        With lichess, those positions are sent to tablebase.lichess.ovh: lichess sees the position
        and your IP address, nothing else. The tables on this device cover the basic endgames;
        nothing is looked up during live, room or engine games. Off switches the lookups in the
        analysis and review off; the endgame lessons still use the tables on this device.
      </p>
      <RookPack />
      <ResetProgress onReset={onResetProgress} />
    </div>
  );
}
