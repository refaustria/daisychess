import {
  moverResult,
  rankMoves,
  tbScoreHint,
  type TbCategory,
  type TbMove,
  type TbScoreHint,
} from '@daisychess/endgames';
import { Chess } from 'chess.js';
import { useEffect, useMemo } from 'react';
import { useTablebaseStore, type TbLookup } from '../../endgames/tablebaseStore';
import { useHumanGameLockReason } from '../../live/lock';
import { currentFen, useGameStore } from '../../store/gameStore';
import styles from './TablebasePanel.module.css';

/** `White wins — mate in 14 · DTZ 15` / `Draw` / `Draw (50-move rule)`. */
export function tbHeadline(hint: TbScoreHint): string {
  if (hint.result === 'draw') return hint.exact50 ? 'Draw' : 'Draw (50-move rule)';
  const side = hint.result === 'white' ? 'White' : 'Black';
  const mate = hint.mateIn !== undefined ? ` — mate in ${hint.mateIn}` : '';
  const dtz = hint.dtz !== undefined ? ` · DTZ ${Math.abs(hint.dtz)}` : '';
  return `${side} wins${mate}${dtz}`;
}

export type MoverWord = 'Win' | 'Draw' | 'Loss';

/**
 * The mover's result after `m` as a word, and whether the 50-move rule decides it (a win or
 * loss that the rule turns into a draw). `m.category` is the opponent's view after the move.
 */
export function moveResult(m: Pick<TbMove, 'category'>): { word: MoverWord; by50: boolean } {
  const opp = moverResult(m.category);
  const word: MoverWord = opp === 'win' ? 'Loss' : opp === 'loss' ? 'Win' : 'Draw';
  const by50 = m.category === 'cursed-win' || m.category === 'blessed-loss';
  return { word, by50 };
}

const BY50_TITLE: Partial<Record<TbCategory, string>> = {
  'blessed-loss': 'A win that the 50-move rule turns into a draw',
  'cursed-win': 'A loss that the 50-move rule turns into a draw',
};

const distance = (n: number | undefined): string => (n === undefined ? '' : String(Math.abs(n)));

/** Status text of a lookup without an answer, or null when nothing is shown. */
export function tbStatusText(cur: Pick<TbLookup, 'status' | 'reason' | 'pack'>): string | null {
  if (cur.status === 'loading') return 'Looking up…';
  if (cur.status !== 'unavailable') return null;
  return cur.reason === 'needs-download' || cur.pack
    ? 'Not available offline (needs the rook endgames download)'
    : 'Not available offline';
}

/**
 * Tablebase panel under the engine lines (ADR-025 §4): for positions with ≤ 7 pieces the exact
 * result ("Tablebase (lichess): White wins — mate in 14 · DTZ 15") and every legal move best
 * first with the mover's result and DTZ/DTM; a click plays the move like the explorer's move table
 * (not during a human game). "Looking up…" while the debounced lookup runs, "Not available
 * offline" without a source, nothing when the setting is `off`, during a human game or for
 * positions the tablebase does not cover.
 */
export function TablebasePanel({ fen }: { fen: string }) {
  const lookup = useTablebaseStore((s) => s.lookup);
  const current = useTablebaseStore((s) => s.current);
  const locked = useHumanGameLockReason() !== null;

  useEffect(() => {
    if (fen) lookup(fen);
  }, [fen, lookup]);

  const pos = current.fen === fen && current.status === 'done' ? current.answer?.pos : undefined;
  const ranked = useMemo(() => (pos ? rankMoves(pos) : []), [pos]);
  if (current.fen !== fen || locked) return null;

  if (!pos || !current.answer) {
    const text = tbStatusText(current);
    if (!text) return null;
    return (
      <section className={styles.panel} aria-label="Tablebase" data-testid="tablebase-panel">
        <p className={styles.status} role="status" data-testid="tablebase-status">
          {text}
        </p>
      </section>
    );
  }

  const source = current.answer.source === 'lichess' ? 'lichess' : 'on this device';
  const headline = tbHeadline(tbScoreHint(pos));

  const play = (m: TbMove) => {
    const g = useGameStore.getState();
    // The board moved on (or a preview): never play into another position.
    if (locked || currentFen(g) !== fen) return;
    const u = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(m.uci);
    if (!u) return;
    try {
      const r = new Chess(fen).move({ from: u[1]!, to: u[2]!, promotion: u[3] });
      g.makeMove(r.from, r.to, r.promotion);
    } catch {
      // Not legal here (stale answer): ignore.
    }
  };

  return (
    <section className={styles.panel} aria-label="Tablebase" data-testid="tablebase-panel">
      <p className={styles.head} data-testid="tablebase-head">
        <span className={styles.title}>Tablebase ({source}):</span> {headline}
      </p>
      {ranked.length > 0 && (
        <table className={styles.moves} data-testid="tablebase-moves">
          <caption className={styles.sr}>Tablebase moves, best first</caption>
          <thead>
            <tr>
              <th scope="col">Move</th>
              <th scope="col">Result</th>
              <th scope="col" className={styles.num}>
                DTZ
              </th>
              <th scope="col" className={styles.num}>
                DTM
              </th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((m) => {
              const r = moveResult(m);
              return (
                <tr key={m.uci} data-uci={m.uci}>
                  <td>
                    <button
                      type="button"
                      className={styles.move}
                      onClick={() => play(m)}
                      disabled={locked}
                      aria-label={`Play ${m.san}`}
                    >
                      {m.san}
                    </button>
                  </td>
                  <td>
                    <span
                      className={styles.result}
                      data-result={r.word.toLowerCase()}
                      title={BY50_TITLE[m.category]}
                    >
                      {r.word}
                      {r.by50 ? '*' : ''}
                    </span>
                  </td>
                  <td className={styles.num}>{m.checkmate ? '' : distance(m.dtz)}</td>
                  <td className={styles.num}>{m.checkmate ? '#' : distance(m.dtm)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
