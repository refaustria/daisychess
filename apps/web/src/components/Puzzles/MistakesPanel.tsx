import { Chess } from 'chess.js';
import { useCallback, useEffect, useId, useState } from 'react';
import type { Puzzle } from '@daisychess/puzzles';
import { lockText, useHumanGameLockReason } from '../../live/lock';
import {
  listGames,
  needsSidePrompt,
  onLedgerChange,
  setUserSide,
  type LedgerGame,
} from '../../puzzles/gameLedger';
import {
  deleteMistake,
  dueMistakes,
  listMistakes,
  onMistakesChange,
  type MistakeRecord,
} from '../../puzzles/mistakeStore';
import {
  resetMistakeSession,
  setMistakeNote,
  useMistakeSession,
} from '../../puzzles/mistakeSession';
import {
  endMistakeTraining,
  nextDueMistake,
  playMistake,
  trainDueMistakes,
} from '../../puzzles/mistakeTraining';
import { usePuzzleStore } from '../../puzzles/puzzleStore';
import { useGameStore } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import styles from './MistakesPanel.module.css';

/** The generator (engine glue) is loaded on first use of this panel only. */
type Generator = typeof import('../../puzzles/mistakeGenerator');

const endSession = (): void => resetMistakeSession();
const setNote = setMistakeNote;

const gameLabel = (g: LedgerGame | undefined): string =>
  g ? `${g.headers.White ?? '?'} vs ${g.headers.Black ?? '?'}` : 'Unknown game';

const moveNumber = (ply: number): string => `${Math.ceil(ply / 2)}${ply % 2 === 1 ? '.' : '...'}`;

/** SAN of a UCI move in `fen`; the UCI text when it cannot be resolved. */
function toSan(fen: string, uci: string | undefined): string {
  if (!uci) return '?';
  try {
    const c = new Chess(fen);
    const m = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.slice(4) || undefined,
    });
    return m.san;
  } catch {
    return uci;
  }
}

/** PGN text of a ledger game (start position, SAN moves, headers); undefined when illegal. */
export function ledgerPgn(g: LedgerGame): string | undefined {
  try {
    const c = new Chess(g.startFen);
    for (const [k, v] of Object.entries(g.headers)) {
      if (k !== 'url' && typeof v === 'string') c.setHeader(k, v);
    }
    for (const san of g.moves) c.move(san);
    return c.pgn();
  } catch {
    return undefined;
  }
}

/** Played vs best move of a stored mistake, as SAN (exported for tests). */
export function mistakeMoves(m: MistakeRecord): { played: string; best: string } {
  const p: Puzzle = m.puzzle;
  let fen = p.fen;
  let best = p.moves[p.noIntro ? 0 : 1];
  if (!p.noIntro) {
    try {
      const c = new Chess(p.fen);
      const o = p.moves[0] ?? '';
      c.move({ from: o.slice(0, 2), to: o.slice(2, 4), promotion: o.slice(4) || undefined });
      fen = c.fen();
    } catch {
      return { played: m.playedUci, best: best ?? '?' };
    }
  }
  best = toSan(fen, best);
  return { played: toSan(fen, m.playedUci), best };
}

function GenProgress({ gen }: { gen: Generator }) {
  const status = gen.useMistakeGenStore((s) => s.status);
  const progress = gen.useMistakeGenStore((s) => s.progress);
  const notice = gen.useMistakeGenStore((s) => s.notice);
  const result = gen.useMistakeGenStore((s) => s.result);
  const running = status === 'running' || status === 'paused';
  return (
    <>
      {running && (
        <div data-testid="mistakes-progress">
          <p className={styles.progress} role="status" aria-live="polite">
            {status === 'paused' ? 'Paused. ' : 'Searching. '}
            {progress
              ? `Games ${progress.gamesDone}/${progress.gamesTotal}, candidates ${progress.candidatesDone}/${progress.candidatesTotal}, found ${progress.found}.`
              : 'Preparing…'}
          </p>
          {notice && (
            <p className={styles.note} role="status" aria-live="polite">
              {notice}
            </p>
          )}
        </div>
      )}
      {running && (
        <div className={styles.row}>
          <button type="button" onClick={() => gen.cancelMistakePuzzles()}>
            Cancel search
          </button>
        </div>
      )}
      {!running && result && (
        <div data-testid="mistakes-result" role="status" aria-live="polite">
          <p>
            {result.status === 'failed'
              ? `The search stopped: ${result.error ?? 'engine error'}. `
              : result.status === 'cancelled'
                ? 'Search cancelled. '
                : 'Search finished. '}
            {result.added.length} new {result.added.length === 1 ? 'puzzle' : 'puzzles'} from{' '}
            {result.gamesScanned} {result.gamesScanned === 1 ? 'game' : 'games'}.
          </p>
          {result.gamesWithoutReview.length > 0 && (
            <p className={styles.note}>
              {result.gamesWithoutReview.length} of your games{' '}
              {result.gamesWithoutReview.length === 1 ? 'has' : 'have'} no review yet; review{' '}
              {result.gamesWithoutReview.length === 1 ? 'it' : 'them'} first, then search again.
            </p>
          )}
        </div>
      )}
    </>
  );
}

export function MistakesPanel() {
  const [mistakes, setMistakes] = useState<MistakeRecord[]>([]);
  const [games, setGames] = useState<LedgerGame[]>([]);
  const [due, setDue] = useState(0);
  const [gen, setGen] = useState<Generator | null>(null);
  const sessionState = useMistakeSession();
  const session = sessionState.active ? sessionState : null;
  const note = sessionState.note;
  // The note belongs to this visit of the panel (it used to be component state).
  useEffect(() => {
    setMistakeNote(undefined);
  }, []);
  const lock = useHumanGameLockReason();
  const puzzleStatus = usePuzzleStore((s) => s.status);
  const phase = usePuzzleStore((s) => s.solver?.phase);
  const inputError = usePuzzleStore((s) => s.inputError);
  const [san, setSan] = useState('');
  const sanId = useId();

  const refresh = useCallback(async () => {
    const [m, g, d] = await Promise.all([listMistakes(), listGames(), dueMistakes()]);
    setMistakes(m);
    setGames(g);
    setDue(d.length);
  }, []);

  useEffect(() => {
    let alive = true;
    const run = () => {
      if (alive) void refresh();
    };
    run();
    const offs = [onMistakesChange(run), onLedgerChange(run)];
    void import('../../puzzles/mistakeGenerator').then((m) => {
      if (alive) setGen(m);
    });
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, [refresh]);

  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!gen) return;
    const sync = () => {
      const st = gen.useMistakeGenStore.getState().status;
      setRunning(st === 'running' || st === 'paused');
    };
    sync();
    return gen.useMistakeGenStore.subscribe(sync);
  }, [gen]);

  const play = (m: MistakeRecord) => playMistake(m, lock);
  const startNext = () => nextDueMistake(lock);
  const trainDue = () => trainDueMistakes(lock);

  const openGame = (m: MistakeRecord, g: LedgerGame) => {
    if (lock) return;
    endSession();
    usePuzzleStore.getState().stop();
    const pgn = ledgerPgn(g);
    if (!pgn || !useGameStore.getState().loadPgn(pgn)) {
      setNote('The game could not be opened.');
      return;
    }
    useGameStore.getState().goTo(m.ply);
    useUiStore.getState().setActiveTab('moves');
  };

  const playOne = (m: MistakeRecord) => {
    endSession();
    play(m);
  };

  const gameByKey = new Map(games.map((g) => [g.gameKey, g]));
  const unknown = games.filter(needsSidePrompt);
  const solving = puzzleStatus === 'running' && session !== null;
  const userTurn = puzzleStatus === 'running' && phase === 'user';

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (usePuzzleStore.getState().playSan(san)) setSan('');
  };

  return (
    <div className={styles.panel} data-testid="mistakes-panel">
      <p data-testid="mistakes-stats" aria-live="polite">
        <strong>{due}</strong> due · {mistakes.length} total
      </p>

      {mistakes.length === 0 && (
        <p className={styles.intro} data-testid="mistakes-empty">
          Puzzles from your own mistakes. Review your games first (the Review tab), set your names
          under My names in Settings so the app knows which side you played, then choose Find
          puzzles in my games. The engine checks each mistake and keeps the ones with a clear best
          move. Everything stays on this device.
        </p>
      )}

      {unknown.length > 0 && (
        <section aria-label="Which side did you play?" data-testid="mistakes-side-prompt">
          <h3 className={styles.heading}>Which side did you play?</h3>
          <ul className={styles.list}>
            {unknown.map((g) => (
              <li key={g.gameKey} className={styles.item}>
                <span className={styles.itemTitle}>Which side did you play in {gameLabel(g)}?</span>
                <div className={styles.row}>
                  {(['white', 'black'] as const).map((side) => (
                    <button
                      key={side}
                      type="button"
                      aria-label={`${side === 'white' ? 'White' : 'Black'}: I played ${side} in ${gameLabel(g)}`}
                      onClick={() => void setUserSide(g.gameKey, side)}
                    >
                      {side === 'white' ? 'White' : 'Black'}
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-label={`Skip ${gameLabel(g)}`}
                    onClick={() => void setUserSide(g.gameKey, 'skip')}
                  >
                    Skip
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className={styles.row}>
        <button
          type="button"
          className={styles.primary}
          disabled={due === 0 || lock !== null || solving}
          onClick={() => void trainDue()}
        >
          Train due
        </button>
        <button
          type="button"
          disabled={!gen || running || lock !== null}
          onClick={() => void gen?.findMistakePuzzles()}
        >
          Find puzzles in my games
        </button>
      </div>
      {lock && <p className={styles.note}>Paused: {lockText(lock)}.</p>}
      {unknown.length > 0 && (
        <p className={styles.note}>Games without an answer above are not searched.</p>
      )}

      {gen && <GenProgress gen={gen} />}

      {session && (
        <div data-testid="mistakes-session">
          <p role="status" aria-live="polite">
            Puzzle {session.index} of {session.total}
            {puzzleStatus === 'done' ? ': finished.' : userTurn ? ': your move.' : '…'}
          </p>
          <form className={styles.sanForm} onSubmit={onSubmit}>
            <label htmlFor={sanId} className={styles.label}>
              Move, e.g. Nf3
            </label>
            <input
              id={sanId}
              className={styles.sanInput}
              value={san}
              onChange={(e) => setSan(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={!userTurn}
            />
            <button type="submit" disabled={!userTurn || san.trim() === ''}>
              Play
            </button>
          </form>
          {inputError && (
            <p className={styles.error} role="alert">
              {inputError}
            </p>
          )}
          {/* On phones these are in the action bar under the board (M29-6). */}
          <div className={styles.row} data-phone-bar>
            <button
              type="button"
              disabled={!userTurn}
              onClick={() => usePuzzleStore.getState().hint()}
            >
              Hint
            </button>
            <button type="button" disabled={puzzleStatus !== 'done'} onClick={startNext}>
              Next due
            </button>
            <button type="button" onClick={endMistakeTraining}>
              End training
            </button>
          </div>
        </div>
      )}
      {note && (
        <p className={styles.note} role="status" data-testid="mistakes-note">
          {note}
        </p>
      )}

      {mistakes.length > 0 && (
        <section aria-label="Mistake puzzles">
          <h3 className={styles.heading}>Your puzzles (newest first)</h3>
          <ul className={styles.list} data-testid="mistakes-list">
            {mistakes.map((m) => {
              const g = gameByKey.get(m.gameKey);
              const mv = mistakeMoves(m);
              const label = gameLabel(g);
              return (
                <li key={m.id} className={styles.item}>
                  <span className={styles.itemTitle}>
                    {label}
                    {g?.headers.Date ? ` · ${g.headers.Date}` : ''}
                  </span>
                  <span className={styles.meta}>
                    Move {moveNumber(m.ply)} · you played {mv.played}, best {mv.best} ·{' '}
                    {m.classification}
                    {g?.headers.url && (
                      <>
                        {' · '}
                        <a href={g.headers.url} target="_blank" rel="noopener noreferrer">
                          Game page
                        </a>
                      </>
                    )}
                  </span>
                  <div className={styles.row}>
                    <button
                      type="button"
                      aria-label={`Play puzzle from ${label}, move ${moveNumber(m.ply)}`}
                      disabled={lock !== null}
                      onClick={() => playOne(m)}
                    >
                      Play
                    </button>
                    {g && (
                      <button
                        type="button"
                        aria-label={`Open game ${label} at move ${moveNumber(m.ply)}`}
                        disabled={lock !== null}
                        onClick={() => openGame(m, g)}
                      >
                        Open game
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Delete puzzle from ${label}, move ${moveNumber(m.ply)}`}
                      onClick={() => void deleteMistake(m.id)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
