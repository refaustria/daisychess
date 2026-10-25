import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { lockText, useHumanGameLockReason } from '../../live/lock';
import {
  getBook,
  loadOpenings,
  onOpeningsLoaded,
  openingsLoaded,
  type Book,
  type BookOpening,
} from '../../openings';
import { openingKey } from '../../openings/book';
import { START_FEN, useGameStore } from '../../store/gameStore';
import { formatLoss } from '../../trainer/drill';
import {
  dueCount,
  useDrillStore,
  type DrillColorChoice,
  type DrillFeedback,
  type DrillState,
} from '../../trainer/drillStore';
import { DAY_MS, dueKeys, type Schedule } from '../../trainer/schedule';
import styles from './OpeningsPanel.module.css';

/** Results shown at most (the search ranks, so the best hits are on top). */
export const MAX_RESULTS = 60;

const COLORS: { id: DrillColorChoice; label: string }[] = [
  { id: 'white', label: 'White' },
  { id: 'black', label: 'Black' },
  { id: 'both', label: 'Both (alternate)' },
];

/** "1. e4 e5 2. Nf3" for the first `n` moves of a line (all by default). */
export function lineText(moves: readonly string[], n = moves.length): string {
  const out: string[] = [];
  for (let i = 0; i < n && i < moves.length; i++) {
    out.push(i % 2 === 0 ? `${i / 2 + 1}. ${moves[i]}` : moves[i]!);
  }
  return out.join(' ');
}

const moveLabel = (moves: readonly string[], i: number): string =>
  i % 2 === 0 ? `${i / 2 + 1}. ${moves[i]}` : `${Math.floor(i / 2) + 1}... ${moves[i]}`;

function pgnFor(o: BookOpening): string {
  const esc = (s: string) => s.replace(/["\\]/g, '');
  return `[Event "${esc(o.name)}"]\n[ECO "${o.eco}"]\n[Opening "${esc(o.name)}"]\n\n${lineText(o.moves)} *`;
}

/**
 * Shows the first `ply` moves of `o`'s line on the board. The whole line is loaded like a PGN
 * import (headers ECO/Opening), so the move list, the opening name and the review work as usual;
 * a line that is already on the board is only navigated.
 */
function showLine(o: BookOpening, ply: number): void {
  const g = useGameStore.getState();
  const loaded =
    g.startFen === START_FEN &&
    g.moves.length === o.moves.length &&
    g.moves.every((m, i) => m.san === o.moves[i]);
  if (!loaded && !g.loadPgn(pgnFor(o))) return;
  useGameStore.getState().goTo(ply);
}

function useBook(): Book | null {
  useSyncExternalStore(onOpeningsLoaded, openingsLoaded);
  useEffect(() => {
    void loadOpenings();
  }, []);
  return getBook();
}

function dueLabel(schedule: Schedule, o: BookOpening, now: number): string | null {
  const e = schedule[openingKey(o)];
  if (!e) return null;
  if (e.due <= now) return 'due';
  const days = Math.ceil((e.due - now) / DAY_MS);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

export function OpeningsPanel() {
  const book = useBook();
  const status = useDrillStore((s) => s.status);
  const drillOpening = useDrillStore((s) => s.opening);
  const [selected, setSelected] = useState<BookOpening | null>(null);
  const [view, setView] = useState<'browse' | 'drill'>('browse');

  // A running or finished drill is shown (also after switching tabs and back).
  const shown = status !== 'idle' && drillOpening ? drillOpening : selected;
  const mode = status !== 'idle' ? 'drill' : view;

  if (!book) {
    return (
      <div className={styles.panel}>
        <p className={styles.note}>Loading openings…</p>
      </div>
    );
  }
  if (!shown) {
    return (
      <div className={styles.panel}>
        <Picker
          book={book}
          onPick={(o) => {
            setSelected(o);
            setView('browse');
          }}
        />
      </div>
    );
  }
  return (
    <div className={styles.panel}>
      <OpeningView
        book={book}
        opening={shown}
        mode={mode}
        onMode={setView}
        onSelect={setSelected}
        onBack={() => {
          useDrillStore.getState().stop();
          setSelected(null);
        }}
      />
    </div>
  );
}

function Picker({ book, onPick }: { book: Book; onPick(o: BookOpening): void }) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [dueOnly, setDueOnly] = useState(false);
  const schedule = useDrillStore((s) => s.schedule);
  const message = useDrillStore((s) => s.message);
  const lock = useHumanGameLockReason();
  const now = Date.now();
  const due = dueCount(schedule, now);

  const results = useMemo(() => {
    if (dueOnly) {
      return dueKeys(schedule, Date.now())
        .map((k) => book.find(k))
        .filter((o): o is BookOpening => o !== undefined);
    }
    if (query.trim()) return book.search(query, MAX_RESULTS);
    // No query: the opening families (names without a variation part).
    return book.openings.filter((o) => !o.name.includes(':')).slice(0, MAX_RESULTS);
  }, [book, query, dueOnly, schedule]);

  return (
    <>
      <p className={styles.intro}>
        Pick an opening, step through its line, or drill it: you play one side, the book plays the
        other, and the engine explains deviations.
      </p>
      {message && <p className={styles.message}>{message}</p>}
      <div className={styles.searchRow}>
        <label htmlFor={searchId} className={styles.srOnly}>
          Search openings
        </label>
        <input
          id={searchId}
          type="search"
          className={styles.search}
          placeholder="Search name or ECO (e.g. Italian, B90)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className={styles.row}>
        <button
          type="button"
          aria-pressed={dueOnly}
          className={dueOnly ? styles.toggleOn : undefined}
          onClick={() => setDueOnly((v) => !v)}
        >
          Due{' '}
          <span className={styles.badge} data-testid="due-count">
            {due}
          </span>
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={due === 0 || lock !== null}
          title={lock ? lockText(lock) : due === 0 ? 'Nothing is due' : undefined}
          onClick={() => useDrillStore.getState().trainDue()}
        >
          Train due
        </button>
      </div>
      {results.length === 0 ? (
        <p className={styles.note}>{dueOnly ? 'Nothing is due.' : 'No opening found.'}</p>
      ) : (
        <ul className={styles.list} aria-label="Openings">
          {results.map((o) => {
            const subs = book.countUnder(o);
            const d = dueLabel(schedule, o, now);
            return (
              <li key={o.id}>
                <button type="button" className={styles.item} onClick={() => onPick(o)}>
                  <span className={styles.eco}>{o.eco}</span>
                  <span className={styles.name}>{o.name}</span>
                  <span className={styles.meta}>
                    {subs > 0 && `${subs} sub-variation${subs === 1 ? '' : 's'}`}
                    {d && (
                      <span className={d === 'due' ? styles.dueBadge : styles.dueLater}>{d}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!dueOnly && !query.trim() && (
        <p className={styles.note}>Showing opening families; type to search all variations.</p>
      )}
    </>
  );
}

interface OpeningViewProps {
  book: Book;
  opening: BookOpening;
  mode: 'browse' | 'drill';
  onMode(m: 'browse' | 'drill'): void;
  onSelect(o: BookOpening): void;
  onBack(): void;
}

function OpeningView({ book, opening, mode, onMode, onSelect, onBack }: OpeningViewProps) {
  const status = useDrillStore((s) => s.status);
  const subs = book.countUnder(opening);
  return (
    <>
      <div className={styles.head}>
        <button type="button" onClick={onBack} aria-label="Back to all openings">
          ← Openings
        </button>
      </div>
      <h3 className={styles.title} data-testid="opening-title">
        <span className={styles.eco}>{opening.eco}</span> {opening.name}
      </h3>
      <p className={styles.meta}>
        {lineText(opening.moves)}
        {subs > 0 && ` · ${subs} sub-variation${subs === 1 ? '' : 's'}`}
      </p>
      {status === 'idle' && (
        <div className={styles.segmented} role="radiogroup" aria-label="Mode">
          {(['browse', 'drill'] as const).map((m) => (
            <label key={m} className={styles.segment}>
              <input
                type="radio"
                name="openings-mode"
                value={m}
                checked={mode === m}
                onChange={() => onMode(m)}
              />
              <span>{m === 'browse' ? 'Browse' : 'Drill'}</span>
            </label>
          ))}
        </div>
      )}
      {mode === 'browse' ? (
        <Browse book={book} opening={opening} onSelect={onSelect} />
      ) : (
        <Drill opening={opening} />
      )}
    </>
  );
}

function Browse({
  book,
  opening,
  onSelect,
}: {
  book: Book;
  opening: BookOpening;
  onSelect(o: BookOpening): void;
}) {
  const lock = useHumanGameLockReason();
  const moves = opening.moves;
  // The board's ply when it shows this line, else none.
  const ply = useGameStore((s) =>
    s.startFen === START_FEN &&
    s.moves.length === moves.length &&
    s.moves.every((m, i) => m.san === moves[i])
      ? s.ply
      : null,
  );
  const at = ply ?? moves.length;
  const branches = book.bookMoves(moves.slice(0, at));
  const subs = useMemo(() => book.variationsUnder(opening), [book, opening]);
  const disabled = lock !== null;
  const title = lock ? `${lockText(lock)} — loading a line would end the game` : undefined;

  const pickBranch = (san: string) => {
    const prefix = [...moves.slice(0, at), san];
    const target = book.openingExactly(prefix) ?? book.variationsUnder({ moves: prefix })[0];
    if (!target) return;
    onSelect(target);
    if (!disabled) showLine(target, Math.min(prefix.length, target.moves.length));
  };

  return (
    <>
      <ol className={styles.moves} aria-label="Line">
        {moves.map((m, i) => (
          <li key={i}>
            <button
              type="button"
              className={ply === i + 1 ? styles.moveActive : styles.move}
              aria-current={ply === i + 1 ? 'step' : undefined}
              disabled={disabled}
              title={title}
              onClick={() => showLine(opening, i + 1)}
            >
              {moveLabel(moves, i)}
            </button>
          </li>
        ))}
      </ol>
      {ply === null && (
        <p className={styles.note}>Click a move to show the position on the board.</p>
      )}
      <section aria-label="Branches">
        <h4 className={styles.sub}>
          {at === 0 ? 'First moves' : `After ${moveLabel(moves, at - 1)}`}
        </h4>
        {branches.length === 0 ? (
          <p className={styles.note}>End of the book line.</p>
        ) : (
          <ul className={styles.branches}>
            {branches.slice(0, 12).map((b) => (
              <li key={b.san}>
                <button
                  type="button"
                  className={styles.branch}
                  onClick={() => pickBranch(b.san)}
                  title={b.names.join(', ')}
                >
                  <strong>{b.san}</strong>
                  <span className={styles.branchName}>{b.opening?.name ?? b.names[0] ?? ''}</span>
                  <span className={styles.meta}>
                    {b.lines} line{b.lines === 1 ? '' : 's'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {subs.length > 0 && (
        <details className={styles.details}>
          <summary>Sub-variations ({subs.length})</summary>
          <ul className={styles.list}>
            {subs.slice(0, 200).map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  className={styles.item}
                  onClick={() => {
                    onSelect(o);
                    if (!disabled) showLine(o, o.moves.length);
                  }}
                >
                  <span className={styles.eco}>{o.eco}</span>
                  <span className={styles.name}>{o.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** The feedback line of the drill. */
export function feedbackText(
  f: DrillFeedback,
  s: Pick<DrillState, 'opening' | 'userColor'>,
): string {
  switch (f.kind) {
    case 'start':
      return s.userColor === 'white' ? `${f.text} Your move.` : `${f.text} The book opens.`;
    case 'book':
      return `Book: ${f.name ?? `${f.san} is a book move`}`;
    case 'app':
      return `Book reply ${f.san}${f.name ? ` (${f.name})` : ''}. Your move.`;
    case 'otherLine':
      return `${f.san} is book${f.name ? ` (${f.name})` : ''}, but not the ${s.opening?.name ?? ''} line. Try again.`;
    case 'checking':
      return `${f.san} is not in the book — checking with the engine…`;
    case 'fine':
      return f.retry
        ? `Not book, but fine (${f.eval}). The ${s.opening?.name ?? ''} line continues differently — try again.`
        : `Not book, but fine (${f.eval}). Out of book.`;
    case 'mistake':
      return `Mistake: ${f.san} loses ${formatLoss(f.lossCp)} (${f.playedEval}).`;
    case 'error':
      return `Engine check failed: ${f.message}`;
    case 'retry':
      return `Try again: find a better move than ${f.san}.`;
  }
}

function Drill({ opening }: { opening: BookOpening }) {
  const s = useDrillStore();
  const lock = useHumanGameLockReason();
  const colorName = useId();
  const engineLine =
    s.runsOn?.kind === 'server'
      ? `Checked on the server${s.runsOn.name ? ` (${s.runsOn.name})` : ''}.`
      : s.runsOn?.kind === 'browser'
        ? 'Checked in the browser.'
        : null;

  if (s.status === 'idle') {
    return (
      <>
        {s.message && <p className={styles.message}>{s.message}</p>}
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>You play</legend>
          <div className={styles.segmented}>
            {COLORS.map((c) => (
              <label key={c.id} className={styles.segment}>
                <input
                  type="radio"
                  name={colorName}
                  value={c.id}
                  checked={s.colorChoice === c.id}
                  onChange={() => s.setColorChoice(c.id)}
                />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <button
          type="button"
          className={styles.primary}
          disabled={lock !== null}
          title={lock ? lockText(lock) : undefined}
          onClick={() => s.start(opening)}
        >
          Start drill
        </button>
        {lock && <p className={styles.note}>{lockText(lock)}: the drill uses the engine.</p>}
        <p className={styles.note}>
          The book plays the other side (main lines more often). A move outside the book is checked
          by the engine: within 0.3 pawns of the best move it is fine, otherwise try again. Mistakes
          come back for training (Due).
        </p>
      </>
    );
  }

  const f = s.feedback;
  return (
    <>
      <div
        className={
          f?.kind === 'mistake' || f?.kind === 'error' ? styles.feedbackBad : styles.feedback
        }
        role="status"
        aria-live="polite"
        data-testid="drill-feedback"
      >
        {f ? feedbackText(f, s) : s.phase === 'user' ? 'Your move.' : '…'}
        {f?.kind === 'mistake' && (
          <p className={styles.best}>
            {f.bestSan ? (
              <>
                Best was <strong>{f.bestSan}</strong> ({f.bestEval})
                {f.pvText && (
                  <>
                    : <span className={styles.pv}>{f.pvText}</span>
                  </>
                )}
              </>
            ) : (
              `Engine eval ${f.bestEval}.`
            )}
          </p>
        )}
      </div>
      {s.status === 'running' && (
        <div className={styles.row}>
          {s.phase === 'retry' && (
            <button type="button" className={styles.primary} onClick={s.retry}>
              Try again
            </button>
          )}
          <button type="button" onClick={() => s.stop()}>
            Stop drill
          </button>
        </div>
      )}
      {s.status === 'running' && s.current && (
        <p className={styles.meta}>Book so far: {s.current}</p>
      )}
      {s.status === 'done' && s.summary && <Summary />}
      {(s.engineNotice || engineLine) && (
        <p className={styles.note}>{s.engineNotice ?? engineLine}</p>
      )}
    </>
  );
}

function Summary() {
  const s = useDrillStore();
  const sum = s.summary!;
  const lock = useHumanGameLockReason();
  const entry = s.opening ? s.schedule[openingKey(s.opening)] : undefined;
  const next = entry
    ? entry.due <= Date.now()
      ? 'It is due again now.'
      : `Next review in ${Math.max(1, Math.round(entry.interval))} day${Math.round(entry.interval) === 1 ? '' : 's'}.`
    : null;
  return (
    <section className={styles.summary} aria-label="Drill summary" data-testid="drill-summary">
      <h4 className={styles.sub}>
        {sum.reason === 'end' ? 'End of the book line' : 'Out of book'}
        {sum.reached ? ` — ${sum.reached}` : ''}
      </h4>
      <p>
        Right first try: <strong>{sum.firstTry}</strong> of {sum.userMoves} move
        {sum.userMoves === 1 ? '' : 's'} · Mistakes: <strong>{sum.mistakes}</strong>
      </p>
      {next && <p className={styles.meta}>{next}</p>}
      <div className={styles.row}>
        <button
          type="button"
          className={styles.primary}
          disabled={lock !== null}
          onClick={s.repeat}
        >
          Repeat
        </button>
        <button type="button" disabled={lock !== null} onClick={s.next}>
          Next variation
        </button>
        <button type="button" onClick={s.playOn}>
          Play on vs engine
        </button>
      </div>
    </section>
  );
}
