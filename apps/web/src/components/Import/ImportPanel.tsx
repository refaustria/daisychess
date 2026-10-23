import { useState, type ChangeEvent, type DragEvent } from 'react';
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
    </div>
  );
}
