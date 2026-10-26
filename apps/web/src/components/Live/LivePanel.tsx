import { useEffect, useId, useState } from 'react';
import { LICHESS_TOKEN_CREATE_URL, useLichessAuth } from '../../lichess/auth';
import { TokenLogin } from '../LichessAccount/LichessAccountSection';
import { isRunning, toMove, type LiveGame, type LiveOpponent } from '../../live/LiveGameController';
import { premoveLabels } from '../../live/premoves';
import {
  BOARD_SCOPE,
  useLiveStore,
  type ColorChoice,
  type IncomingChallenge,
  type OngoingGame,
} from '../../live/liveStore';
import {
  CHALLENGE_TIME_CONTROLS,
  clockLabel,
  findTimeControl,
  SEEK_TIME_CONTROLS,
  toClock,
  type TimeControl,
} from '../../live/timeControls';
import { usePlayStore } from '../../play/playStore';
import { currentFen, useGameStore } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { useTicker } from './LiveClock';
import styles from './LivePanel.module.css';

const COLORS: { id: ColorChoice; label: string }[] = [
  { id: 'random', label: 'Random' },
  { id: 'white', label: 'White' },
  { id: 'black', label: 'Black' },
];

export const REASON_TEXT: Record<string, string> = {
  mate: 'checkmate',
  resign: 'resignation',
  stalemate: 'stalemate',
  timeout: 'opponent left the game',
  draw: 'draw',
  outoftime: 'time out',
  aborted: 'game aborted',
  noStart: 'game not started in time',
  cheat: 'cheat detected',
  variantEnd: 'variant ending',
  unknownFinish: 'game over',
};

export function playerLabel(p: Pick<LiveOpponent, 'name' | 'rating' | 'title'>): string {
  return `${p.title ? `${p.title} ` : ''}${p.name}${p.rating !== undefined ? ` (${p.rating})` : ''}`;
}

export function verdict(g: Pick<LiveGame, 'winner' | 'color' | 'reason'>): string {
  if (g.reason === 'aborted' || g.reason === 'noStart') return 'Game aborted';
  if (!g.winner) return 'Draw';
  return g.winner === g.color ? 'You won' : 'You lost';
}

const resultText = (g: Pick<LiveGame, 'winner' | 'reason'>): string =>
  g.reason === 'aborted' || g.reason === 'noStart'
    ? '*'
    : g.winner === 'white'
      ? '1-0'
      : g.winner === 'black'
        ? '0-1'
        : '½-½';

function Segmented<T extends string>(props: {
  legend: string;
  name: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange(v: T): void;
}) {
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.legend}>{props.legend}</legend>
      <div className={styles.segmented}>
        {props.options.map((o) => (
          <label key={o.id} className={styles.segment}>
            <input
              type="radio"
              name={props.name}
              value={o.id}
              checked={props.value === o.id}
              onChange={() => props.onChange(o.id)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function TimeSelect(props: {
  label: string;
  list: readonly TimeControl[];
  value: string;
  onChange(v: string): void;
}) {
  return (
    <label className={styles.field}>
      <span>{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.list.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Messages() {
  const error = useLiveStore((s) => s.error);
  const notice = useLiveStore((s) => s.notice);
  const clear = useLiveStore((s) => s.clearMessages);
  if (!error && !notice) return null;
  return (
    <div className={error ? styles.error : styles.notice} role={error ? 'alert' : 'status'}>
      <span>{error ?? notice}</span>
      <button type="button" className={styles.close} aria-label="Dismiss message" onClick={clear}>
        ×
      </button>
    </div>
  );
}

function LoginPrompt() {
  const status = useLichessAuth((a) => a.status);
  const authError = useLichessAuth((a) => a.error);
  const source = useLichessAuth((a) => a.source);
  const authed = status === 'authenticated';
  const viaToken = authed && source === 'token';
  return (
    <div className={styles.panel}>
      {viaToken ? (
        <>
          <p>
            Your personal token doesn&apos;t include &quot;Play games with the Board API&quot; (
            <code>{BOARD_SCOPE}</code>).{' '}
            <a
              className={styles.link}
              href={LICHESS_TOKEN_CREATE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Create a new token on lichess
            </a>{' '}
            (the permissions are prefilled) and paste it below to replace this one.
          </p>
          <TokenLogin open summary="Replace the personal access token" />
        </>
      ) : (
        <>
          <p>
            {authed
              ? 'Your lichess login does not allow playing games yet. Log in again to grant the board:play permission.'
              : 'Play rated or casual games on lichess.org from this board: quick pairing, the lichess computer or a friend. Log in with your lichess account, or use a personal access token.'}
          </p>
          {authError && (
            <p className={styles.errorText} role="alert">
              {authError}
            </p>
          )}
          <button
            type="button"
            className={styles.primary}
            disabled={status === 'authorizing'}
            onClick={() => void useLichessAuth.getState().login()}
          >
            {status === 'authorizing'
              ? 'Logging in…'
              : authed
                ? 'Log in again'
                : 'Log in with lichess'}
          </button>
          {!authed && <TokenLogin summary="Use a personal access token" />}
        </>
      )}
      <p className={styles.note}>
        Engines and the review are disabled while a live game runs (lichess fair play).
      </p>
    </div>
  );
}

function Challenges({ list }: { list: IncomingChallenge[] }) {
  const accept = useLiveStore((s) => s.accept);
  const decline = useLiveStore((s) => s.decline);
  if (list.length === 0) return null;
  return (
    <section className={styles.section} aria-label="Incoming challenges">
      <h3 className={styles.heading}>Incoming challenges</h3>
      <ul className={styles.list}>
        {list.map((c) => {
          const supported = c.variant === 'standard';
          return (
            <li key={c.id} className={styles.item} data-testid="challenge">
              <span>
                <strong>{playerLabel(c.challenger)}</strong>
                <span className={styles.muted}>
                  {' · '}
                  {c.clock ? clockLabel(c.clock) : 'correspondence'} ·{' '}
                  {c.rated ? 'rated' : 'casual'}
                  {!supported && ` · ${c.variant} (not supported)`}
                </span>
              </span>
              <span className={styles.actions}>
                <button type="button" disabled={!supported} onClick={() => void accept(c.id)}>
                  Accept
                </button>
                <button type="button" onClick={() => void decline(c.id)}>
                  Decline
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Ongoing({ list }: { list: OngoingGame[] }) {
  const resume = useLiveStore((s) => s.resume);
  if (list.length === 0) return null;
  return (
    <section className={styles.section} aria-label="Ongoing games">
      <h3 className={styles.heading}>Your ongoing games</h3>
      <ul className={styles.list}>
        {list.map((g) => (
          <li key={g.gameId} className={styles.item}>
            <span>
              vs <strong>{g.opponent.name}</strong>
              <span className={styles.muted}>
                {' · '}
                {g.color} · {g.speed}
                {g.isMyTurn ? ' · your move' : ''}
              </span>
            </span>
            <button type="button" onClick={() => resume(g.gameId)}>
              Resume
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Setup() {
  const id = useId();
  const seek = useLiveStore((s) => s.seek);
  const challengeAi = useLiveStore((s) => s.challengeAi);
  const challengeUser = useLiveStore((s) => s.challengeUser);
  const challenges = useLiveStore((s) => s.challenges);
  const ongoing = useLiveStore((s) => s.ongoing);
  const enginePlaying = usePlayStore((p) => p.mode === 'playing');
  const [seekTc, setSeekTc] = useState(SEEK_TIME_CONTROLS[0]!.id);
  const [rated, setRated] = useState(true);
  const [color, setColor] = useState<ColorChoice>('random');
  const [level, setLevel] = useState(3);
  const [aiTc, setAiTc] = useState('5+3');
  const [friend, setFriend] = useState('');
  const [friendTc, setFriendTc] = useState('5+3');
  const [friendRated, setFriendRated] = useState(false);

  return (
    <div className={styles.panel}>
      <Challenges list={challenges} />
      <Ongoing list={ongoing} />
      {enginePlaying && (
        <p className={styles.errorText} role="status">
          Finish or stop the game against the engine first.
        </p>
      )}
      <form
        className={styles.section}
        aria-label="Quick pairing"
        onSubmit={(e) => {
          e.preventDefault();
          const t = findTimeControl(seekTc, SEEK_TIME_CONTROLS);
          void seek({ rated, time: t.minutes, increment: t.increment, color });
        }}
      >
        <h3 className={styles.heading}>Quick pairing</h3>
        <Segmented
          legend="Time control"
          name={`${id}-seek-tc`}
          options={SEEK_TIME_CONTROLS}
          value={seekTc}
          onChange={setSeekTc}
        />
        <Segmented<ColorChoice>
          legend="Your colour"
          name={`${id}-color`}
          options={COLORS}
          value={color}
          onChange={setColor}
        />
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={rated}
            onChange={(e) => setRated(e.currentTarget.checked)}
          />
          Rated
        </label>
        <button type="submit" className={styles.primary} disabled={enginePlaying}>
          Find an opponent
        </button>
        <p className={styles.note}>
          Board API rule: lichess only allows human opponents in rapid, classical and correspondence
          games from boards like this one (via seeks); blitz and bullet are possible against the
          computer or friends.
        </p>
      </form>

      <form
        className={styles.section}
        aria-label="Play the computer"
        onSubmit={(e) => {
          e.preventDefault();
          void challengeAi(level, toClock(findTimeControl(aiTc)), color);
        }}
      >
        <h3 className={styles.heading}>Play the lichess computer</h3>
        <label className={styles.field}>
          <span>Level</span>
          <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((l) => (
              <option key={l} value={l}>
                Level {l}
              </option>
            ))}
          </select>
        </label>
        <TimeSelect label="Clock" list={CHALLENGE_TIME_CONTROLS} value={aiTc} onChange={setAiTc} />
        <button type="submit" disabled={enginePlaying}>
          Play the computer
        </button>
      </form>

      <form
        className={styles.section}
        aria-label="Challenge a friend"
        onSubmit={(e) => {
          e.preventDefault();
          void challengeUser(friend, {
            clock: toClock(findTimeControl(friendTc)),
            rated: friendRated,
            color,
          });
        }}
      >
        <h3 className={styles.heading}>Challenge a friend</h3>
        <label className={styles.field}>
          <span>lichess username</span>
          <input
            type="text"
            value={friend}
            autoComplete="off"
            spellCheck={false}
            maxLength={30}
            onChange={(e) => setFriend(e.target.value)}
          />
        </label>
        <TimeSelect
          label="Clock"
          list={CHALLENGE_TIME_CONTROLS}
          value={friendTc}
          onChange={setFriendTc}
        />
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={friendRated}
            onChange={(e) => setFriendRated(e.currentTarget.checked)}
          />
          Rated
        </label>
        <button type="submit" disabled={enginePlaying || !friend.trim()}>
          Send challenge
        </button>
      </form>
      <p className={styles.note}>
        Live analysis, the review and the explorer are disabled while a live game runs (lichess fair
        play).
      </p>
    </div>
  );
}

function Seeking() {
  const pending = useLiveStore((s) => s.pending);
  const cancel = useLiveStore((s) => s.cancelSeek);
  return (
    <div className={styles.panel}>
      <p className={styles.seeking} role="status" aria-live="polite">
        <span className={styles.spinner} aria-hidden="true" />
        {pending?.kind === 'seek'
          ? `Looking for an opponent (${pending.label})…`
          : (pending?.label ?? 'Waiting…')}
      </p>
      <button type="button" onClick={() => void cancel()}>
        Cancel
      </button>
    </div>
  );
}

function Playing({ game }: { game: LiveGame }) {
  const atTip = useGameStore((s) => s.ply === s.moves.length);
  const tipFen = useGameStore((s) =>
    currentFen({ startFen: s.startFen, moves: s.moves, ply: s.moves.length }),
  );
  const live = useLiveStore();
  const premoves = live.premoves.length ? premoveLabels(tipFen, game.color, live.premoves) : [];
  const [confirmResign, setConfirmResign] = useState(false);
  const claimAt = game.opponentGone?.claimAt;
  const now = useTicker(claimAt !== undefined, Date.now, 500);
  const myTurn = isRunning(game) && toMove(game, game.moves.length) === game.color;
  const canAbort = game.moves.length < 2;
  const canClaim = claimAt !== undefined && now >= claimAt;
  const status = game.opponentGone
    ? canClaim
      ? 'Opponent left – you can claim victory'
      : `Opponent left${claimAt !== undefined ? ` – claim victory in ${Math.max(0, Math.ceil((claimAt - now) / 1000))} s` : ''}`
    : myTurn
      ? atTip
        ? 'Your move'
        : 'Your move (go to the last move to play)'
      : 'Waiting for opponent';

  return (
    <div className={styles.panel} data-testid="live-game">
      <p className={styles.player}>
        <span>
          vs <span data-testid="live-opponent">{playerLabel(game.opponent)}</span>{' '}
          <span className={styles.muted}>(you play {game.color})</span>
        </span>
      </p>
      <p
        className={myTurn ? `${styles.status} ${styles.statusYou}` : styles.status}
        role="status"
        aria-live="polite"
        data-testid="live-status"
      >
        {status}
      </p>
      {premoves.length > 0 && (
        <p className={styles.premoves} data-testid="live-premoves">
          Premoves: {premoves.join(', ')} <span className={styles.muted}>(Esc to clear)</span>
          <button type="button" className={styles.linkBtn} onClick={live.clearPremoves}>
            Clear
          </button>
        </p>
      )}
      <p className={styles.meta}>
        {game.rated ? 'Rated' : 'Casual'} · {game.speed}
        {game.clock
          ? ` · ${clockLabel({ limit: game.clock.initial / 1000, increment: game.clock.increment / 1000 })}`
          : ''}
      </p>
      {game.drawOffer === 'opponent' && (
        <div className={styles.banner} role="alert">
          <span>Your opponent offers a draw.</span>
          <span className={styles.actions}>
            <button type="button" onClick={() => void live.acceptDraw()}>
              Accept
            </button>
            <button type="button" onClick={() => void live.declineDraw()}>
              Decline
            </button>
          </span>
        </div>
      )}
      {confirmResign ? (
        <div className={styles.row}>
          <span>Resign this game?</span>
          <button
            type="button"
            className={styles.danger}
            onClick={() => {
              setConfirmResign(false);
              void live.resign();
            }}
          >
            Yes, resign
          </button>
          <button type="button" onClick={() => setConfirmResign(false)}>
            No
          </button>
        </div>
      ) : (
        <div className={styles.row}>
          <button
            type="button"
            onClick={() => void live.offerDraw()}
            disabled={game.drawOffer !== undefined}
          >
            {game.drawOffer === 'mine' ? 'Draw offered' : 'Offer draw'}
          </button>
          {canAbort ? (
            <button type="button" onClick={() => void live.abort()}>
              Abort
            </button>
          ) : (
            <button type="button" onClick={() => setConfirmResign(true)}>
              Resign
            </button>
          )}
          {canClaim && (
            <button
              type="button"
              className={styles.primary}
              onClick={() => void live.claimVictory()}
            >
              Claim victory
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Finished({ game }: { game: LiveGame }) {
  const leave = useLiveStore((s) => s.leave);
  const setTab = useUiStore((s) => s.setActiveTab);
  const reason = game.reason ? (REASON_TEXT[game.reason] ?? game.reason) : undefined;
  return (
    <div className={styles.panel} data-testid="live-finished">
      <p className={styles.meta}>vs {playerLabel(game.opponent)}</p>
      <div className={styles.result} role="status" aria-live="polite">
        <span className={styles.score} data-testid="live-result">
          {resultText(game)}
        </span>
        <span>
          <strong>{verdict(game)}</strong>
          {reason && <> — {reason}</>}
        </span>
      </div>
      <div className={styles.row}>
        <button type="button" className={styles.primary} onClick={leave}>
          New game
        </button>
        <button type="button" onClick={() => setTab('review')}>
          Review this game
        </button>
        <a
          className={styles.link}
          href={`https://lichess.org/${game.id}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open on lichess
        </a>
      </div>
    </div>
  );
}

/** "Live" tab: lichess games through the Board API (login, setup, running game, result). */
export function LivePanel() {
  const scoped = useLichessAuth(
    (a) => a.status === 'authenticated' && a.scopes.includes(BOARD_SCOPE),
  );
  const status = useLiveStore((s) => s.status);
  const game = useLiveStore((s) => s.game);
  const setActive = useLiveStore((s) => s.setActive);

  useEffect(() => {
    setActive(true);
    return () => setActive(false);
  }, [setActive, scoped]);

  if (!scoped && status !== 'playing' && status !== 'finished') {
    return (
      <>
        <Messages />
        <LoginPrompt />
      </>
    );
  }
  return (
    <div className={styles.wrap} data-testid="live-panel" data-status={status}>
      <Messages />
      {status === 'seeking' && <Seeking />}
      {status === 'playing' &&
        (game ? (
          <Playing game={game} />
        ) : (
          <p className={styles.status} role="status">
            Connecting to the game…
          </p>
        ))}
      {status === 'finished' && game && <Finished game={game} />}
      {(status === 'idle' || status === 'error' || (status === 'finished' && !game)) && <Setup />}
    </div>
  );
}
