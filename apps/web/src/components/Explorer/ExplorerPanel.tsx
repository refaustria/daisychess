import { Chess } from 'chess.js';
import { useEffect, useId, useRef, useState } from 'react';
import {
  ExplorerError,
  fetchExplorerGamePgn,
  RATINGS,
  SPEEDS,
  TOKEN_CREATE_URL,
  type ExplorerDb,
  type ExplorerGame,
  type ExplorerMove,
  type RatingGroup,
  type Speed,
} from '../../explorer/client';
import { explorerToken, useExplorerStore, type ExplorerErrorInfo } from '../../explorer/explorerStore';
import { useLichessAuth } from '../../lichess/auth';
import { LoginButton } from '../LichessAccount/LoginButton';
import { lockText, useHumanGameLockReason } from '../../live/lock';
import { useGameStore } from '../../store/gameStore';
import styles from './ExplorerPanel.module.css';

interface Props {
  /** Called after a game from the list was loaded. */
  onLoaded?: () => void;
}

const DBS: { id: ExplorerDb; label: string }[] = [
  { id: 'masters', label: 'Masters' },
  { id: 'lichess', label: 'Lichess' },
];

const SPEED_LABEL: Record<Speed, string> = {
  ultraBullet: 'UltraBullet',
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classical',
  correspondence: 'Correspondence',
};

const fmt = new Intl.NumberFormat('en-US');

function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

/** Same position for explorer purposes: placement, side, castling, en passant. */
const samePosition = (a: string, b: string) => a.split(' ').slice(0, 4).join(' ') === b.split(' ').slice(0, 4).join(' ');

function Wdl({ white, draws, black, label }: { white: number; draws: number; black: number; label: string }) {
  const total = white + draws + black;
  const w = pct(white, total);
  const b = pct(black, total);
  const d = total > 0 ? 100 - w - b : 0;
  const text = `White ${w}%, draw ${d}%, Black ${b}%`;
  return (
    <div className={styles.wdl} role="img" aria-label={`${label}: ${text}`} title={text}>
      <span className={styles.barWhite} style={{ width: `${w}%` }}>
        {w >= 12 ? `${w}%` : ''}
      </span>
      <span className={styles.barDraw} style={{ width: `${d}%` }}>
        {d >= 12 ? `${d}%` : ''}
      </span>
      <span className={styles.barBlack} style={{ width: `${b}%` }}>
        {b >= 12 ? `${b}%` : ''}
      </span>
    </div>
  );
}

function playerText(p: { name: string; rating?: number }): string {
  return p.rating !== undefined ? `${p.name} (${p.rating})` : p.name;
}

function gameDate(g: ExplorerGame): string {
  return g.month ?? (g.year !== undefined ? String(g.year) : '');
}

function errorView(e: ExplorerErrorInfo, loggedIn: boolean): { text: string; tokenHelp: boolean } {
  switch (e.kind) {
    case 'unauthorized':
      if (loggedIn) {
        return { text: 'Explorer not reachable: lichess rejected your login. Log out and in again in Settings.', tokenHelp: false };
      }
      return e.withToken
        ? { text: 'Explorer not reachable: lichess rejected the token. Check it under Advanced.', tokenHelp: true }
        : {
            text: 'Explorer not reachable without a lichess account: lichess requires authentication for the opening explorer. Log in with lichess, or paste a token under Advanced.',
            tokenHelp: true,
          };
    case 'rate_limited':
      return { text: `Rate limited by lichess – retrying in ${e.retryAfter ?? 60} s`, tokenHelp: false };
    default:
      return { text: e.message, tokenHelp: false };
  }
}

export function ExplorerPanel({ onLoaded }: Props) {
  const st = useExplorerStore();
  // Fair play: no explorer data while a human game runs (live lichess game or vs the engine).
  const lock = useHumanGameLockReason();
  const locked = lock !== null;
  const loginName = useLichessAuth((a) => (a.status === 'authenticated' ? a.username : undefined));
  const loggedIn = loginName !== undefined;
  const ids = useId();
  const [tokenDraft, setTokenDraft] = useState(st.token);
  const [showToken, setShowToken] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [loadingId, setLoadingId] = useState('');
  const [loadMsg, setLoadMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const loadSeq = useRef(0);

  useEffect(() => {
    if (locked) return;
    const seq = loadSeq;
    useExplorerStore.getState().setActive(true);
    return () => {
      seq.current++; // drop pending game loads
      useExplorerStore.getState().setActive(false);
    };
  }, [locked]);

  const needsToken = st.status === 'error' && st.error?.kind === 'unauthorized';
  useEffect(() => {
    if (needsToken) setAdvancedOpen(true);
  }, [needsToken]);

  const playMove = (m: ExplorerMove) => {
    const fen = st.fen;
    if (!fen || locked) return;
    // The explorer encodes castling king-to-rook (e1h1); resolve via SAN to board squares.
    let from: string;
    let to: string;
    let promotion: string | undefined;
    try {
      const r = new Chess(fen).move(m.san);
      from = r.from;
      to = r.to;
      promotion = r.promotion;
    } catch {
      return;
    }
    useGameStore.getState().makeMove(from, to, promotion);
  };

  const loadGame = async (g: ExplorerGame) => {
    const seq = ++loadSeq.current;
    const db = st.db;
    const fen = st.fen;
    setLoadingId(g.id);
    setLoadMsg(null);
    try {
      const token = explorerToken(st.token);
      const pgn = await fetchExplorerGamePgn(db, g.id, token ? { token } : {});
      if (seq !== loadSeq.current) return;
      const game = useGameStore.getState();
      if (!game.loadPgn(pgn)) {
        setLoadMsg({ ok: false, text: 'Could not read the game (invalid PGN)' });
        return;
      }
      // Jump to the explored position inside the loaded game (start if not found).
      const after = useGameStore.getState();
      const idx = fen ? after.moves.findIndex((mv) => samePosition(mv.fen, fen)) : -1;
      const startMatch = fen ? samePosition(after.startFen, fen) : false;
      after.goTo(startMatch ? 0 : idx >= 0 ? idx + 1 : 0);
      setLoadMsg({ ok: true, text: `Loaded: ${g.white.name} – ${g.black.name}` });
      onLoaded?.();
    } catch (e) {
      if (seq !== loadSeq.current) return;
      const text =
        e instanceof ExplorerError
          ? e.kind === 'unauthorized'
            ? 'Loading masters games requires a lichess login or token'
            : e.message
          : 'Could not load the game';
      setLoadMsg({ ok: false, text });
    } finally {
      if (seq === loadSeq.current) setLoadingId('');
    }
  };

  const toggleSpeed = (s: Speed) => {
    const next = st.speeds.includes(s) ? st.speeds.filter((x) => x !== s) : [...st.speeds, s];
    if (next.length > 0) st.setSpeeds(next);
  };
  const toggleRating = (r: RatingGroup) => {
    const next = st.ratings.includes(r) ? st.ratings.filter((x) => x !== r) : [...st.ratings, r];
    if (next.length > 0) st.setRatings(next);
  };

  const data = st.status === 'ready' ? st.data : undefined;
  const total = data ? data.white + data.draws + data.black : 0;
  const err = st.status === 'error' && st.error ? errorView(st.error, loggedIn) : null;

  let statusText = '';
  if (st.status === 'loading') statusText = 'Loading explorer…';
  else if (st.status === 'too_deep') statusText = 'Beyond the explorer depth (50 plies)';
  else if (data && total === 0) statusText = 'Position not found in database';
  else if (data) statusText = `${fmt.format(total)} ${total === 1 ? 'game' : 'games'}`;

  const games: { title: string; list: ExplorerGame[] }[] = data
    ? st.db === 'masters'
      ? [{ title: 'Top games', list: data.topGames }]
      : [
          { title: 'Top games', list: data.topGames },
          { title: 'Recent games', list: data.recentGames },
        ]
    : [];

  return (
    <section className={styles.panel} aria-label="Opening explorer">
      <div className={styles.header}>
        <div className={styles.dbs} role="radiogroup" aria-label="Database">
          {DBS.map((d) => (
            <label key={d.id} className={styles.db}>
              <input
                type="radio"
                className={styles.dbInput}
                name={`${ids}-db`}
                checked={st.db === d.id}
                onChange={() => st.setDb(d.id)}
              />
              <span>{d.label}</span>
            </label>
          ))}
        </div>
        {data?.opening && (
          <p className={styles.opening} data-testid="explorer-opening">
            <span className={styles.eco}>{data.opening.eco}</span> {data.opening.name}
          </p>
        )}
      </div>

      {st.db === 'lichess' && (
        <details className={styles.details}>
          <summary>Filters</summary>
          <fieldset className={styles.fieldset}>
            <legend>Speeds</legend>
            {SPEEDS.map((s) => (
              <label key={s} className={styles.check}>
                <input type="checkbox" checked={st.speeds.includes(s)} onChange={() => toggleSpeed(s)} />
                {SPEED_LABEL[s]}
              </label>
            ))}
          </fieldset>
          <fieldset className={styles.fieldset}>
            <legend>Ratings</legend>
            {RATINGS.map((r) => (
              <label key={r} className={styles.check}>
                <input type="checkbox" checked={st.ratings.includes(r)} onChange={() => toggleRating(r)} />
                {r === 0 ? '< 1000' : r === 2500 ? '2500+' : r}
              </label>
            ))}
          </fieldset>
        </details>
      )}

      <p className={styles.status} role="status" aria-live="polite">
        {locked ? '' : statusText}
      </p>
      {locked && (
        <p className={styles.status} data-testid="explorer-locked">
          {lockText(lock)}
        </p>
      )}

      {err && (
        <div className={styles.errorBox} role="alert">
          <p className={styles.error}>{err.text}</p>
          {err.tokenHelp && (
            <>
              <LoginButton />
              <p className={styles.help}>
                Or{' '}
                <a href={TOKEN_CREATE_URL} target="_blank" rel="noopener noreferrer">
                  create a lichess token
                </a>{' '}
                (no permissions needed) and paste it under Advanced.
              </p>
            </>
          )}
          {st.error?.kind !== 'unauthorized' && (
            <button type="button" onClick={() => st.refresh()}>
              Retry
            </button>
          )}
        </div>
      )}

      {data && total > 0 && (
        <>
          <Wdl white={data.white} draws={data.draws} black={data.black} label="Results" />

          <table className={styles.moves}>
            <caption className={styles.sr}>Popular moves</caption>
            <thead>
              <tr>
                <th scope="col">Move</th>
                <th scope="col" className={styles.num}>
                  Games
                </th>
                <th scope="col">Results</th>
                <th scope="col" className={styles.num}>
                  Avg
                </th>
              </tr>
            </thead>
            <tbody>
              {data.moves.map((m) => {
                const n = m.white + m.draws + m.black;
                return (
                  <tr key={m.uci}>
                    <td>
                      <button
                        type="button"
                        className={styles.move}
                        onClick={() => playMove(m)}
                        disabled={locked}
                        aria-label={`Play ${m.san}`}
                      >
                        {m.san}
                      </button>
                    </td>
                    <td className={styles.num}>
                      {fmt.format(n)} <span className={styles.muted}>{pct(n, total)}%</span>
                    </td>
                    <td className={styles.barCell}>
                      <Wdl white={m.white} draws={m.draws} black={m.black} label={m.san} />
                    </td>
                    <td className={styles.num}>{m.averageRating ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {games.map(
            (sec) =>
              sec.list.length > 0 && (
                <div key={sec.title} className={styles.group}>
                  <h2 className={styles.heading}>{sec.title}</h2>
                  <ul className={styles.games} aria-label={sec.title}>
                    {sec.list.map((g) => (
                      <li key={g.id} className={styles.game}>
                        <span className={styles.players}>
                          <span className={g.winner === 'white' ? styles.winner : undefined}>
                            {playerText(g.white)}
                            {g.winner === 'white' && (
                              <>
                                <span aria-hidden="true"> ✓</span>
                                <span className={styles.sr}> (won)</span>
                              </>
                            )}
                          </span>
                          {' – '}
                          <span className={g.winner === 'black' ? styles.winner : undefined}>
                            {playerText(g.black)}
                            {g.winner === 'black' && (
                              <>
                                <span aria-hidden="true"> ✓</span>
                                <span className={styles.sr}> (won)</span>
                              </>
                            )}
                          </span>
                          {g.winner === null && <span className={styles.muted}> (draw)</span>}
                        </span>
                        <span className={styles.meta}>
                          {[g.speed ? SPEED_LABEL[g.speed as Speed] ?? g.speed : '', gameDate(g)]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                        <button
                          type="button"
                          className={styles.load}
                          onClick={() => void loadGame(g)}
                          disabled={locked || loadingId !== ''}
                          aria-label={`Load ${g.white.name} – ${g.black.name}`}
                        >
                          {loadingId === g.id ? 'Loading…' : 'Load'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ),
          )}
        </>
      )}

      {loadMsg && (
        <p className={loadMsg.ok ? styles.status : styles.error} role={loadMsg.ok ? 'status' : 'alert'}>
          {loadMsg.text}
        </p>
      )}

      <p className={styles.status} data-testid="explorer-auth">
        {loggedIn
          ? `Using your lichess login (${loginName})`
          : st.token
            ? 'Using the pasted lichess token'
            : 'Not logged in with lichess'}
      </p>

      <details
        className={styles.details}
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>Advanced</summary>
        <form
          className={styles.tokenForm}
          onSubmit={(e) => {
            e.preventDefault();
            st.setToken(tokenDraft);
          }}
        >
          <label htmlFor={`${ids}-token`}>or paste a token</label>
          <div className={styles.row}>
            <input
              id={`${ids}-token`}
              className={styles.input}
              type={showToken ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
            />
            <button type="button" onClick={() => setShowToken((v) => !v)} aria-pressed={showToken}>
              {showToken ? 'Hide' : 'Show'}
            </button>
          </div>
          <div className={styles.row}>
            <button type="submit">Save</button>
            {st.token && (
              <button
                type="button"
                onClick={() => {
                  setTokenDraft('');
                  st.setToken('');
                }}
              >
                Clear
              </button>
            )}
          </div>
          <p className={styles.help}>
            lichess requires authentication for the explorer since Nov 2025. Logging in with lichess (Settings) is
            easiest; alternatively{' '}
            <a href={TOKEN_CREATE_URL} target="_blank" rel="noopener noreferrer">
              create a token on lichess
            </a>{' '}
            without any permissions. It is stored in this browser only and sent only to the lichess explorer.
            {st.token ? ' A token is saved.' : ''}
            {st.token && loggedIn ? ' Your lichess login is used instead while you are logged in.' : ''}
          </p>
        </form>
      </details>
    </section>
  );
}
