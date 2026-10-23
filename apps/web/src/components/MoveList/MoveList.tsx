import { useEffect, useRef } from 'react';
import { CLASS_INFO } from '../../review/format';
import { useReviewStore } from '../../review/reviewStore';
import { gameStatus, useGameStore, type MoveRecord } from '../../store/gameStore';
import { useOpening } from '../../openings/useOpening';
import styles from './MoveList.module.css';

// TODO: variations (README "PGN import & navigation") are not supported yet.

interface Row {
  num: number;
  white?: { san: string; ply: number };
  black?: { san: string; ply: number };
}

export function buildRows(startFen: string, moves: MoveRecord[]): Row[] {
  const parts = startFen.split(' ');
  let num = Number(parts[5]) || 1;
  let black = parts[1] === 'b';
  const rows: Row[] = [];
  moves.forEach((m, i) => {
    const entry = { san: m.san, ply: i + 1 };
    if (!black) {
      rows.push({ num, white: entry });
    } else {
      const last = rows[rows.length - 1];
      if (last && last.num === num && !last.black) last.black = entry;
      else rows.push({ num, black: entry });
      num += 1;
    }
    black = !black;
  });
  return rows;
}

export function MoveList() {
  const startFen = useGameStore((s) => s.startFen);
  const moves = useGameStore((s) => s.moves);
  const ply = useGameStore((s) => s.ply);
  const headers = useGameStore((s) => s.headers);
  const goTo = useGameStore((s) => s.goTo);
  const state = useGameStore();
  const reviewed = useReviewStore((s) => (s.status === 'done' ? s.summary : undefined));
  const opening = useOpening();
  const currentRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [ply, moves]);

  const rows = buildRows(startFen, moves);
  const over = ply === moves.length && gameStatus(state) !== 'playing';
  const status = gameStatus(state);
  const sideToMoveWhite = (state.moves[ply - 1]?.fen ?? startFen).split(' ')[1] === 'w';
  const computed = status === 'checkmate' ? (sideToMoveWhite ? '0-1' : '1-0') : '1/2-1/2';
  const result = headers.Result && headers.Result !== '*' ? headers.Result : computed;

  const cell = (m: { san: string; ply: number } | undefined, num: number, isBlack: boolean) => {
    if (!m) return <span className={styles.empty}>…</span>;
    const current = m.ply === ply;
    const played = state.moves[m.ply - 1];
    const found = reviewed?.moves.find((x) => x.ply === m.ply);
    // Ignore a stale review of a different game.
    const r =
      found && played && found.uci === `${played.from}${played.to}${played.promotion ?? ''}`
        ? found
        : undefined;
    const info = r ? CLASS_INFO[r.classification] : undefined;
    return (
      <button
        type="button"
        ref={current ? currentRef : undefined}
        className={current ? `${styles.move} ${styles.current}` : styles.move}
        aria-label={`${num}${isBlack ? '...' : '.'} ${m.san}`}
        aria-current={current ? 'true' : undefined}
        onClick={() => goTo(m.ply)}
      >
        {m.san}
        {r && info && info.glyph && (
          <span
            className={styles.badge}
            style={{ color: info.color }}
            data-class={r.classification}
            title={`${info.label} (−${Math.round(r.winProbLoss)}% win probability)`}
          >
            {info.glyph}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className={styles.wrap} data-testid="movelist">
      {(headers.White || headers.Black) && (
        <div className={styles.header}>
          <div className={styles.players}>
            {[headers.White, headers.Black].filter(Boolean).join(' – ')}
          </div>
          {headers.Result && headers.Result !== '*' && (
            <div className={styles.result}>{headers.Result}</div>
          )}
        </div>
      )}
      <div
        className={styles.opening}
        aria-live="polite"
        data-testid="opening"
        title="Opening as of the current position"
      >
        {opening && (
          <>
            <span className={styles.eco}>{opening.eco}</span>
            <span className={styles.openingName}>{opening.name}</span>
          </>
        )}
      </div>
      <div className={styles.list}>
        {rows.length === 0 && <p className={styles.hint}>No moves yet.</p>}
        {rows.map((r) => (
          <div key={`${r.num}-${r.white?.ply ?? r.black?.ply}`} className={styles.row}>
            <span className={styles.num}>{r.num}.</span>
            {r.white ? cell(r.white, r.num, false) : <span className={styles.empty}>…</span>}
            {cell(r.black, r.num, true)}
          </div>
        ))}
        {over && <div className={styles.end}>{result}</div>}
      </div>
    </div>
  );
}
