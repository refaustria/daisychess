import { ROOM_BOUNDS, type RoomColorChoice } from '@daisychess/engine-core';
import { useEffect, useId, useRef, useState } from 'react';
import { timeControlLabel } from '../../clock/timeControls';
import { isLiveLocked, useLiveStore } from '../../live/liveStore';
import { premoveLabels } from '../../live/premoves';
import { usePlayStore } from '../../play/playStore';
import { EXPIRED_TEXT, useRoomStore } from '../../room/roomStore';
import { roomLink } from '../../room/route';
import { sideToMoveAt } from '../../room/RoomMirror';
import { isValidNick } from '../../room/storage';
import {
  claimRemainingMs,
  roomNick,
  roomResultText,
  roomStatusLine,
  type RoomView,
} from '../../room/view';
import { currentFen, useGameStore } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { useTicker } from '../Live/LiveClock';
import { TimeControlField } from '../Play/PlayPanel';
import styles from './FriendPanel.module.css';

const COLORS: { id: RoomColorChoice; label: string }[] = [
  { id: 'white', label: 'White' },
  { id: 'black', label: 'Black' },
  { id: 'random', label: 'Random' },
];

const RESULT_SCORE = { '1-0': '1-0', '0-1': '0-1', '1/2-1/2': '½-½' } as const;

function Messages() {
  const error = useRoomStore((s) => s.error);
  const notice = useRoomStore((s) => s.notice);
  const clear = useRoomStore((s) => s.clearMessages);
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

function Connection() {
  const connection = useRoomStore((s) => s.connection);
  if (connection !== 'retrying') return null;
  return (
    <p className={styles.seeking} role="status" data-testid="friend-reconnecting">
      <span className={styles.spinner} aria-hidden="true" />
      Connection lost – reconnecting…
    </p>
  );
}

function NickField(props: { value: string; onChange(v: string): void; autoFocus?: boolean }) {
  return (
    <label className={styles.field}>
      <span>Nickname</span>
      <input
        type="text"
        value={props.value}
        autoComplete="nickname"
        spellCheck={false}
        maxLength={ROOM_BOUNDS.nick.max}
        autoFocus={props.autoFocus}
        onChange={(e) => props.onChange(e.target.value)}
        data-testid="friend-nick"
      />
    </label>
  );
}

/** Another game blocks starting one here (engine or lichess game). */
function useOtherGame(): string | null {
  const engine = usePlayStore((p) => p.mode === 'playing');
  const live = useLiveStore((l) => isLiveLocked(l));
  if (engine) return 'Finish or stop the game against the engine first.';
  if (live) return 'Finish the live game on lichess first.';
  return null;
}

function CreateForm() {
  const id = useId();
  const setup = useRoomStore((s) => s.setup);
  const setSetup = useRoomStore((s) => s.setSetup);
  const create = useRoomStore((s) => s.create);
  const blocked = useOtherGame();
  const valid = isValidNick(setup.nick);
  return (
    <form
      className={styles.section}
      aria-label="Play a friend"
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <h3 className={styles.heading}>Play a friend via link</h3>
      <p className={styles.note}>
        Create a link and send it to your friend. No account needed – just pick a nickname.
      </p>
      <NickField value={setup.nick} onChange={(nick) => setSetup({ nick })} />
      <TimeControlField value={setup.clock} onChange={(clock) => setSetup({ clock })} />
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Your colour</legend>
        <div className={styles.segmented}>
          {COLORS.map((c) => (
            <label key={c.id} className={styles.segment}>
              <input
                type="radio"
                name={`${id}-color`}
                value={c.id}
                checked={setup.color === c.id}
                onChange={() => setSetup({ color: c.id })}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {blocked && (
        <p className={styles.errorText} role="status">
          {blocked}
        </p>
      )}
      <button type="submit" className={styles.primary} disabled={!valid || blocked !== null}>
        Create link
      </button>
      <p className={styles.note}>
        Engines, the review and the explorer are disabled while you play (fair play).
      </p>
    </form>
  );
}

function JoinCard() {
  const setup = useRoomStore((s) => s.setup);
  const join = useRoomStore((s) => s.join);
  const leave = useRoomStore((s) => s.leave);
  const [nick, setNick] = useState(setup.nick);
  const blocked = useOtherGame();
  return (
    <form
      className={styles.section}
      aria-label="Join the game"
      data-testid="friend-join"
      onSubmit={(e) => {
        e.preventDefault();
        join(nick);
      }}
    >
      <h3 className={styles.heading}>You are invited to a game</h3>
      <p className={styles.note}>Pick a nickname to join. If both seats are taken you watch.</p>
      <NickField value={nick} onChange={setNick} autoFocus />
      {blocked && (
        <p className={styles.errorText} role="status">
          {blocked}
        </p>
      )}
      <div className={styles.row}>
        <button type="submit" className={styles.primary} disabled={!isValidNick(nick) || blocked !== null}>
          Join
        </button>
        <button type="button" onClick={leave}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Busy({ text }: { text: string }) {
  return (
    <p className={styles.seeking} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      {text}
    </p>
  );
}

function LinkBox({ roomId }: { roomId: string }) {
  const link = roomLink(roomId);
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // No clipboard access (permissions, insecure context): select it for Ctrl+C.
      input.current?.select();
    }
  };
  return (
    <div className={styles.linkBox}>
      <input
        ref={input}
        type="text"
        readOnly
        value={link}
        aria-label="Game link"
        data-testid="friend-link"
        onFocus={(e) => e.currentTarget.select()}
      />
      <button type="button" onClick={() => void copy()} data-testid="friend-copy">
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

const vsLine = (r: RoomView): string => `${roomNick(r, 'white')} vs ${roomNick(r, 'black')}`;

const setupLine = (r: RoomView): string =>
  r.clock ? timeControlLabel({ initialMs: r.clock.initialMs, incrementMs: r.clock.incrementMs }) : 'No clock';

function Waiting({ room }: { room: RoomView }) {
  const abort = useRoomStore((s) => s.abort);
  const leave = useRoomStore((s) => s.leave);
  if (room.you === 'spectator') {
    return (
      <div className={styles.panel}>
        <p className={styles.status}>Waiting for players…</p>
        <button type="button" onClick={leave}>
          Leave
        </button>
      </div>
    );
  }
  return (
    <div className={styles.panel} data-testid="friend-waiting">
      <p className={styles.meta}>
        You play {room.you} · {setupLine(room)}
      </p>
      <LinkBox roomId={room.roomId} />
      <Busy text="Waiting for your friend…" />
      <p className={styles.note}>Send the link to your friend. The game starts when they join.</p>
      <div className={styles.row}>
        <button type="button" onClick={abort}>
          Cancel link
        </button>
      </div>
    </div>
  );
}

function Playing({ room }: { room: RoomView }) {
  const store = useRoomStore();
  const tipFen = useGameStore((s) => currentFen({ startFen: s.startFen, moves: s.moves, ply: s.moves.length }));
  const atTip = useGameStore((s) => s.ply === s.moves.length);
  const [confirm, setConfirm] = useState<'resign' | 'leave' | null>(null);
  const claimPending = claimRemainingMs(room, Date.now()) !== null;
  const now = useTicker(claimPending, Date.now, 500);
  const claimMs = claimRemainingMs(room, now);
  const spectator = room.you === 'spectator';
  const me = room.you === 'spectator' ? null : room.you;
  const opp = me === 'white' ? 'black' : me === 'black' ? 'white' : null;
  const myTurn = me !== null && sideToMoveAt(room.moves.length) === me && store.pendingMove === undefined;
  const premoves = me && store.premoves.length ? premoveLabels(tipFen, me, store.premoves) : [];
  const canAbort = room.moves.length < 2;
  const status = roomStatusLine(room, store.pendingMove !== undefined) ?? '';

  if (spectator) {
    return (
      <div className={styles.panel} data-testid="friend-game" data-role="spectator">
        <p className={styles.status} data-testid="friend-watching">
          Watching {vsLine(room)}
        </p>
        <p className={styles.meta}>
          {setupLine(room)} · {status}
        </p>
        <button type="button" onClick={store.leave}>
          Leave
        </button>
      </div>
    );
  }

  const oppNick = opp ? roomNick(room, opp) : '';
  const oppGone = opp !== null && room.players[opp]?.connected === false;
  return (
    <div className={styles.panel} data-testid="friend-game" data-role="player">
      <p className={styles.player}>
        <span>
          vs <span data-testid="friend-opponent">{oppNick}</span>{' '}
          <span className={styles.muted}>(you play {me})</span>
        </span>
      </p>
      <p
        className={myTurn ? `${styles.status} ${styles.statusYou}` : styles.status}
        role="status"
        aria-live="polite"
        data-testid="friend-status"
      >
        {myTurn && !atTip ? 'Your move (go to the last move to play)' : status}
      </p>
      <p className={styles.meta}>
        {setupLine(room)}
        {room.spectators > 0 ? ` · ${room.spectators} watching` : ''}
      </p>
      {oppGone && (
        <p className={styles.banner} role="status" data-testid="friend-claim">
          {claimMs === null || claimMs > 0
            ? `${oppNick} disconnected${claimMs !== null ? `, claim in ${Math.ceil(claimMs / 1000)} s` : ''}`
            : `${oppNick} disconnected – you can claim the win`}
        </p>
      )}
      {premoves.length > 0 && (
        <p className={styles.premoves} data-testid="friend-premoves">
          Premoves: {premoves.join(', ')} <span className={styles.muted}>(Esc to clear)</span>
          <button type="button" className={styles.linkBtn} onClick={store.clearPremoves}>
            Clear
          </button>
        </p>
      )}
      {room.drawOffer !== undefined && room.drawOffer === opp && (
        <div className={styles.banner} role="alert">
          <span>{oppNick} offers a draw.</span>
          <span className={styles.actions}>
            <button type="button" onClick={store.acceptDraw}>
              Accept
            </button>
            <button type="button" onClick={store.declineDraw}>
              Decline
            </button>
          </span>
        </div>
      )}
      {confirm ? (
        <div className={styles.row}>
          <span>{confirm === 'resign' ? 'Resign this game?' : `Leave? ${oppNick} can claim the win if you do not come back.`}</span>
          <button
            type="button"
            className={styles.danger}
            onClick={() => {
              setConfirm(null);
              if (confirm === 'resign') store.resign();
              else store.leave();
            }}
          >
            {confirm === 'resign' ? 'Yes, resign' : 'Yes, leave'}
          </button>
          <button type="button" onClick={() => setConfirm(null)}>
            No
          </button>
        </div>
      ) : (
        <div className={styles.row}>
          {room.drawOffer === me ? (
            <button type="button" onClick={store.declineDraw} title="Withdraw your draw offer">
              Draw offered (withdraw)
            </button>
          ) : (
            <button type="button" onClick={store.offerDraw} disabled={room.drawOffer !== undefined}>
              Offer draw
            </button>
          )}
          {canAbort ? (
            <button type="button" onClick={store.abort}>
              Abort
            </button>
          ) : (
            <button type="button" onClick={() => setConfirm('resign')}>
              Resign
            </button>
          )}
          {claimMs !== null && claimMs <= 0 && (
            <button type="button" className={styles.primary} onClick={store.claim}>
              Claim victory
            </button>
          )}
          <button type="button" onClick={() => setConfirm('leave')}>
            Leave
          </button>
        </div>
      )}
    </div>
  );
}

function Finished({ room }: { room: RoomView }) {
  const leave = useRoomStore((s) => s.leave);
  const playAgain = useRoomStore((s) => s.playAgain);
  const setTab = useUiStore((s) => s.setActiveTab);
  const blocked = useOtherGame();
  const played = room.result !== undefined;
  return (
    <div className={styles.panel} data-testid="friend-finished">
      <p className={styles.meta}>
        {vsLine(room)} · {setupLine(room)}
      </p>
      <div className={styles.result} role="status" aria-live="polite">
        <span className={styles.score} data-testid="friend-result">
          {room.result ? RESULT_SCORE[room.result] : '*'}
        </span>
        <strong data-testid="friend-result-text">{roomResultText(room)}</strong>
      </div>
      <div className={styles.row}>
        {room.you !== 'spectator' && (
          <button type="button" className={styles.primary} onClick={playAgain} disabled={blocked !== null}>
            {played ? 'Play again (new link)' : 'Create another link'}
          </button>
        )}
        {played && room.moves.length > 0 && (
          <button type="button" onClick={() => setTab('review')}>
            Review this game
          </button>
        )}
        <button type="button" onClick={leave}>
          {room.you === 'spectator' ? 'Leave' : 'New setup'}
        </button>
      </div>
      {room.you !== 'spectator' && played && (
        <p className={styles.note}>“Play again” creates a new link with colours swapped – send it to your friend.</p>
      )}
    </div>
  );
}

function Expired() {
  const leave = useRoomStore((s) => s.leave);
  return (
    <div className={styles.panel} data-testid="friend-expired">
      <p className={styles.status} role="status">
        {EXPIRED_TEXT}.
      </p>
      <p className={styles.note}>Games are kept only for a while after they end, and not across server restarts.</p>
      <button type="button" className={styles.primary} onClick={leave}>
        Create a new game
      </button>
    </div>
  );
}

/** "Friend" tab: play a friend via a link on our own server (ADR-013), no account. */
export function FriendPanel() {
  const phase = useRoomStore((s) => s.phase);
  const room = useRoomStore((s) => s.room);
  return (
    <div className={styles.wrap} data-testid="friend-panel" data-phase={phase} data-status={room?.status}>
      <Messages />
      <Connection />
      {phase === 'idle' && (
        <div className={styles.panel}>
          <CreateForm />
        </div>
      )}
      {phase === 'creating' && <Busy text="Creating the link…" />}
      {phase === 'join' && (
        <div className={styles.panel}>
          <JoinCard />
        </div>
      )}
      {phase === 'joining' && <Busy text="Joining the game…" />}
      {phase === 'attaching' && <Busy text="Reconnecting to your game…" />}
      {phase === 'expired' && <Expired />}
      {phase === 'room' && room?.status === 'waiting' && <Waiting room={room} />}
      {phase === 'room' && room?.status === 'playing' && <Playing room={room} />}
      {phase === 'room' && room?.status === 'finished' && <Finished room={room} />}
    </div>
  );
}
