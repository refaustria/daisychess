import { createElement, useEffect } from 'react';
import { loadPieceSet } from '../Board/pieceCss';
import type { Orientation } from '../../store/gameStore';
import { useSettingsStore } from '../../store/settingsStore';
import { PIECE_ORDER, PIECE_ROLE, material, type PieceType } from './material';
import styles from './CapturedPieces.module.css';

export interface CapturedPiecesProps {
  /** The bar's player: shows the pieces this side has captured and its advantage. */
  side: Orientation;
  startFen: string;
  fen: string;
}

const plural = (n: number, role: string) =>
  n === 1 ? `1 ${role}` : `${n} ${role === 'knight' ? 'knights' : `${role}s`}`;

/** Captured pieces (icons in the current piece set) and the material advantage of one side. */
export function CapturedPieces({ side, startFen, fen }: CapturedPiecesProps) {
  const pieceSet = useSettingsStore((s) => s.pieceSet);
  useEffect(() => {
    void loadPieceSet(pieceSet);
  }, [pieceSet]);

  const m = material(startFen, fen);
  const opponent = side === 'white' ? 'black' : 'white';
  const lost = m.lost[opponent];
  const lead = side === 'white' ? m.advantage : -m.advantage;
  const groups = PIECE_ORDER.filter((t) => lost[t] > 0);
  if (groups.length === 0 && lead <= 0) return null;

  const label =
    'captured: ' +
    [...groups.map((t) => plural(lost[t], PIECE_ROLE[t])), ...(lead > 0 ? [`+${lead}`] : [])].join(
      ', ',
    );
  const many = groups.reduce((n, t) => n + lost[t], 0) > 8;
  return (
    <span
      className={`cg-wrap piece-set-${pieceSet} ${styles.root}`}
      role="img"
      aria-label={label}
      data-testid={`captured-${side}`}
    >
      {groups.map((t: PieceType) => (
        <span key={t} className={many ? `${styles.group} ${styles.dense}` : styles.group} aria-hidden>
          {Array.from({ length: lost[t] }, (_, i) =>
            createElement('piece', {
              key: i,
              className: `${styles.icon} ${opponent} ${PIECE_ROLE[t]}`,
            }),
          )}
        </span>
      ))}
      {lead > 0 && (
        <span className={styles.lead} data-testid={`advantage-${side}`} aria-hidden>
          +{lead}
        </span>
      )}
    </span>
  );
}
