import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  OnlineImportError,
  SITE_LABEL,
  fetchOnlineGamePgn,
  fetchOnlineGames,
  type OnlineGame,
  type OnlineSite,
} from '../../import';
import { lichessFetch, useLichessAuth } from '../../lichess/auth';
import { useOpenedPgn } from '../../platform/openedPgn';
import { splitPgnGames } from '../../store/pgn';
import { useGameStore } from '../../store/gameStore';
import styles from './ImportPanel.module.css';

interface Props {
  /** Called after a successful FEN/PGN load. */
  onLoaded?: () => void;
}

function tag(game: string, name: string): string | undefined {
  return new RegExp(`^\\s*\\[${name}\\s+"([^"]*)"\\]`, 'm').exec(game)?.[1];
}

export function gameLabel(game: string, i: number): string {
  const w = tag(game, 'White');
  const b = tag(game, 'Black');
  if (!w && !b) return `Game ${i + 1}`;
  const r = tag(game, 'Result');
  return `${w ?? '?'} – ${b ?? '?'}${r ? ` (${r})` : ''}`;
}

const STORAGE_KEY = 'daisychess.import.online';
const SITES: OnlineSite[] = ['lichess', 'chesscom'];

interface Saved {
  site: OnlineSite;
  users: Partial<Record<OnlineSite, string>>;
}

function readSaved(): Saved {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      const r = raw as { site?: unknown; users?: Record<string, unknown> };
      const users: Saved['users'] = {};
      for (const k of SITES) if (typeof r.users?.[k] === 'string') users[k] = r.users[k] as string;
      return { site: r.site === 'chesscom' ? 'chesscom' : 'lichess', users };
    }
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return { site: 'lichess', users: {} };
}

function writeSaved(v: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function playerLabel(p: { name: string; rating?: number }): string {
  return p.rating !== undefined ? `${p.name} (${p.rating})` : p.name;
}

function errorText(e: unknown): string {
  return e instanceof OnlineImportError ? e.message : 'Something went wrong – please try again';
}

export function ImportPanel({ onLoaded }: Props) {
  const loadFen = useGameStore((s) => s.loadFen);
  const loadPgn = useGameStore((s) => s.loadPgn);
  const [fen, setFen] = useState('');
  const [fenError, setFenError] = useState('');
  const [pgn, setPgn] = useState('');
  const [pgnError, setPgnError] = useState('');
  const [games, setGames] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [dragging, setDragging] = useState(false);

  const [saved] = useState(readSaved);
  const [site, setSite] = useState<OnlineSite>(saved.site);
  const [users, setUsers] = useState(saved.users);
  const [online, setOnline] = useState<OnlineGame[] | null>(null);
  const [fetchedFor, setFetchedFor] = useState('');
  const [fetching, setFetching] = useState(false);
  const [loadingId, setLoadingId] = useState('');
  const [onlineError, setOnlineError] = useState('');
  const [onlineOk, setOnlineOk] = useState('');
  /** The listed games were fetched with the lichess login (so their PGNs are fetched with it too). */
  const [withLogin, setWithLogin] = useState(false);
  const seq = useRef(0);
  const username = users[site] ?? '';
  const me = useLichessAuth((a) => (a.status === 'authenticated' ? a.username : undefined));

  const chooseSite = (next: OnlineSite) => {
    seq.current++;
    setSite(next);
    setOnline(null);
    setOnlineError('');
    setOnlineOk('');
    setFetching(false);
    setLoadingId('');
    writeSaved({ site: next, users });
  };

  const fetchGames = async (
    forSite: OnlineSite = site,
    name: string = username.trim(),
    mine = false,
  ) => {
    const id = ++seq.current;
    setFetching(true);
    setOnlineError('');
    setOnlineOk('');
    setOnline(null);
    setLoadingId('');
    setWithLogin(mine);
    try {
      const list = await (mine
        ? fetchOnlineGames(forSite, name, { fetch: lichessFetch })
        : fetchOnlineGames(forSite, name));
      if (id !== seq.current) return;
      setOnline(list);
      setFetchedFor(name);
      writeSaved({ site: forSite, users: { ...users, [forSite]: name } });
    } catch (e) {
      if (id === seq.current) setOnlineError(errorText(e));
    } finally {
      if (id === seq.current) setFetching(false);
    }
  };

  const openOnline = async (game: OnlineGame) => {
    const id = ++seq.current;
    setLoadingId(game.id);
    setOnlineError('');
    setOnlineOk('');
    try {
      const text = await (withLogin
        ? fetchOnlineGamePgn(game, { fetch: lichessFetch })
        : fetchOnlineGamePgn(game));
      if (id !== seq.current) return;
      if (loadPgn(text)) {
        useGameStore.getState().goTo(0);
        setOnlineOk(`Loaded: ${game.white.name} – ${game.black.name}`);
        onLoaded?.();
      } else setOnlineError('Could not read the game (invalid PGN)');
    } catch (e) {
      if (id === seq.current) setOnlineError(errorText(e));
    } finally {
      if (id === seq.current) setLoadingId('');
    }
  };

  const submitFen = () => {
    if (loadFen(fen)) {
      setFenError('');
      onLoaded?.();
    } else setFenError('Invalid FEN');
  };

  const loadOne = (game: string) => {
    if (loadPgn(game)) {
      useGameStore.getState().goTo(0);
      setPgnError('');
      onLoaded?.();
    } else setPgnError('Invalid PGN');
  };

  const submitText = (text: string) => {
    const list = splitPgnGames(text);
    if (list.length === 0) {
      setGames([]);
      setPgnError('Invalid PGN');
      return;
    }
    setGames(list);
    setSelected(0);
    if (list.length === 1) loadOne(list[0] as string);
    else setPgnError('');
  };

  // A .pgn opened with DaisyChess from another app (platform/openedPgn): same flow as a pasted file.
  const openedSeq = useOpenedPgn((s) => s.seq);
  useEffect(() => {
    const { text, clear } = useOpenedPgn.getState();
    if (!text) return;
    clear();
    setPgn(text);
    submitText(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per opened file
  }, [openedSeq]);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setPgn(text);
    submitText(text);
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    void readFile(e.target.files?.[0]);
    e.target.value = '';
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    void readFile(e.dataTransfer.files[0]);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.group}>
        <div className={styles.row}>
          <input
            className={styles.input}
            aria-label="Position to import"
            placeholder="Paste FEN"
            value={fen}
            onChange={(e) => setFen(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitFen()}
          />
          <button type="button" onClick={submitFen}>
            Load
          </button>
        </div>
        {fenError && (
          <p className={styles.error} role="alert">
            {fenError}
          </p>
        )}
      </div>

      <div className={styles.group}>
        <textarea
          className={styles.textarea}
          aria-label="PGN text"
          placeholder="Paste PGN"
          rows={6}
          value={pgn}
          onChange={(e) => setPgn(e.target.value)}
        />
        <div className={styles.row}>
          <button type="button" onClick={() => submitText(pgn)}>
            Load PGN
          </button>
        </div>
        <label
          className={dragging ? `${styles.drop} ${styles.dragging}` : styles.drop}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          Drop a .pgn file here or click to choose
          <input
            type="file"
            accept=".pgn"
            aria-label="PGN file"
            className={styles.file}
            onChange={onFile}
          />
        </label>
        {games.length > 1 && (
          <div className={styles.row}>
            <select
              className={styles.input}
              aria-label="Game"
              value={selected}
              onChange={(e) => setSelected(Number(e.target.value))}
            >
              {games.map((g, i) => (
                <option key={i} value={i}>
                  {gameLabel(g, i)}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => loadOne(games[selected] as string)}>
              Open game
            </button>
          </div>
        )}
        {pgnError && (
          <p className={styles.error} role="alert">
            {pgnError}
          </p>
        )}
      </div>

      <section className={styles.group} aria-labelledby="online-heading">
        <h3 id="online-heading" className={styles.heading}>
          Online games
        </h3>
        <div role="radiogroup" aria-label="Site" className={styles.sites}>
          {SITES.map((s) => (
            <label key={s} className={styles.site}>
              <input
                type="radio"
                name="online-site"
                className={styles.siteInput}
                checked={site === s}
                onChange={() => chooseSite(s)}
              />
              <span>{SITE_LABEL[s]}</span>
            </label>
          ))}
        </div>
        <div className={styles.row}>
          <input
            className={styles.input}
            aria-label="Username"
            placeholder={`${SITE_LABEL[site]} username`}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsers({ ...users, [site]: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && !fetching && void fetchGames()}
          />
          <button type="button" disabled={fetching} onClick={() => void fetchGames()}>
            Fetch games
          </button>
        </div>
        {me && (
          <div className={styles.row}>
            <button
              type="button"
              disabled={fetching}
              title={`Your recent lichess games as ${me}, fetched with your lichess login`}
              onClick={() => {
                if (site !== 'lichess') chooseSite('lichess');
                setUsers((u) => ({ ...u, lichess: me }));
                void fetchGames('lichess', me, true);
              }}
            >
              My games
            </button>
          </div>
        )}
        {fetching && (
          <p className={styles.status} role="status">
            Loading games…
          </p>
        )}
        {onlineError && (
          <p className={styles.error} role="alert">
            {onlineError}
          </p>
        )}
        {onlineOk && (
          <p className={styles.status} role="status">
            {onlineOk}
          </p>
        )}
        {online && online.length === 0 && <p className={styles.status}>No games found.</p>}
        {online && online.length > 0 && (
          <ul className={styles.games} aria-label="Recent games">
            {online.map((g) => {
              const meWhite = same(g.white.name, fetchedFor);
              const meBlack = same(g.black.name, fetchedFor);
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    className={styles.game}
                    disabled={loadingId !== ''}
                    aria-busy={loadingId === g.id}
                    onClick={() => void openOnline(g)}
                  >
                    <span className={styles.players}>
                      <span className={meWhite ? styles.me : undefined}>
                        {playerLabel(g.white)}
                        {meWhite && <span className={styles.sr}> (you, White)</span>}
                      </span>
                      {' – '}
                      <span className={meBlack ? styles.me : undefined}>
                        {playerLabel(g.black)}
                        {meBlack && <span className={styles.sr}> (you, Black)</span>}
                      </span>
                    </span>
                    <span className={styles.meta}>
                      {[g.result, g.date.slice(0, 10), g.timeControl ?? g.speed, g.opening]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
