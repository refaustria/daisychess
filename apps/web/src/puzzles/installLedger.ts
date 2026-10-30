/**
 * Fills the game ledger (ADR-023 §9) without touching the review code: watches the review store
 * for a finished or loaded review (`status: 'done'` with a stored record, i.e. a review the review
 * cache keeps under the game's key) that belongs to the game on the board, and records that game
 * with its headers, its source and the user's side.
 *
 * Game sources: a running engine game, live lichess game or friend game "claims" the game store's
 * `headers` object (all three keep one headers object per game; every load or new game replaces
 * it, see `isGameLoad`). When the review is done, the claim only counts while the board still
 * shows that headers object, so a PGN loaded after an engine game is never taken for the engine
 * game.
 */
import { isLiveLocked, useLiveStore } from '../live/liveStore';
import { usePlayStore } from '../play/playStore';
import { gameKey, MIN_CACHED_PLIES } from '../review/reviewCache';
import { gameToBatch, useReviewStore, type ReviewState } from '../review/reviewStore';
import { useRoomStore, type RoomState } from '../room/roomStore';
import { useGameStore, type GameState } from '../store/gameStore';
import { ledgerHeaders, recordReviewedGame, type LedgerGame } from './gameLedger';
import { gameUrl, knownNames, resolveUserSide, type GameSources, type Side } from './userSide';

interface Claim {
  headers: GameState['headers'];
  source: keyof GameSources;
  side: Side;
}

/** The latest game claim; shared by the ledger subscriber and {@link activeGameSources}. */
let claim: Claim | undefined;

/**
 * The game sources that own the game whose headers object is `headers` (the board's game): the
 * running or just finished engine / live / friend game that claimed it, else none. The claim is
 * kept up to date by {@link installLedger}.
 */
export function activeGameSources(headers: GameState['headers']): GameSources {
  return claim && claim.headers === headers ? { [claim.source]: claim.side } : {};
}

export interface LedgerHooks {
  now: () => number;
  names: () => string[];
  record: (game: Parameters<typeof recordReviewedGame>[0]) => Promise<LedgerGame | undefined>;
}

const defaultHooks = (): LedgerHooks => ({
  now: () => Date.now(),
  names: knownNames,
  record: recordReviewedGame,
});

/** The user's seat in a room game that runs or has just finished (not a spectator). */
function roomSide(s: Pick<RoomState, 'phase' | 'room'>): Side | undefined {
  if (s.phase !== 'room' || !s.room) return undefined;
  const you = s.room.you;
  return you === 'white' || you === 'black' ? you : undefined;
}

const roomPlaying = (s: Pick<RoomState, 'phase' | 'room'>): boolean =>
  s.phase === 'room' && s.room?.status === 'playing';

/** The source whose game is running right now, if any. */
function runningClaim(headers: GameState['headers']): Claim | undefined {
  const play = usePlayStore.getState();
  if (play.mode === 'playing') return { headers, source: 'play', side: play.playerColor };
  const live = useLiveStore.getState();
  if (live.status === 'playing' && live.game)
    return { headers, source: 'live', side: live.game.color };
  const room = useRoomStore.getState();
  const side = roomSide(room);
  if (roomPlaying(room) && side) return { headers, source: 'room', side };
  return undefined;
}

/** True when the review state `s` newly shows a finished review (fresh run or cached load). */
function newlyDone(s: ReviewState, prev: ReviewState): boolean {
  if (s.status !== 'done' || !s.stored || !s.reviewed) return false;
  return prev.status !== 'done' || prev.reviewed !== s.reviewed || prev.stored !== s.stored;
}

/**
 * Installs the ledger subscriber (app start). `hooks` replace the clock, the known names and the
 * ledger write (tests). Returns the unsubscribe function.
 */
export function installLedger(overrides: Partial<LedgerHooks> = {}): () => void {
  const hooks = { ...defaultHooks(), ...overrides };
  claim = runningClaim(useGameStore.getState().headers);

  const capture = (): void => {
    const c = runningClaim(useGameStore.getState().headers);
    if (c) claim = c;
  };
  /** A game of `source` just ended: it owns the headers on the board now. */
  const ended = (source: Claim['source'], side: Side | undefined): void => {
    if (side) claim = { headers: useGameStore.getState().headers, source, side };
  };

  const unwatchGame = useGameStore.subscribe((s, prev) => {
    if (s.headers !== prev.headers) capture();
  });
  const unwatchPlay = usePlayStore.subscribe((s, prev) => {
    if (s.mode === 'playing' && prev.mode !== 'playing') capture();
    if (s.mode === 'finished' && prev.mode === 'playing' && s.reason !== 'aborted')
      ended('play', s.playerColor);
  });
  const unwatchLive = useLiveStore.subscribe((s, prev) => {
    if (s.status === 'playing' && (prev.status !== 'playing' || s.game !== prev.game)) capture();
    if (s.status === 'finished' && prev.status === 'playing') ended('live', s.game?.color);
  });
  const unwatchRoom = useRoomStore.subscribe((s, prev) => {
    if (roomPlaying(s) && !roomPlaying(prev)) capture();
    if (!roomPlaying(s) && roomPlaying(prev) && s.room?.status === 'finished')
      ended('room', roomSide(s));
  });

  const unwatchReview = useReviewStore.subscribe((s, prev) => {
    if (!newlyDone(s, prev)) return;
    const g = useGameStore.getState();
    // The review must belong to the game on the board (same moves array).
    if (g.moves !== s.reviewed || g.moves.length < MIN_CACHED_PLIES) return;
    // A human game never shows a review while it runs; be safe anyway.
    if (isLiveLocked(useLiveStore.getState()) || usePlayStore.getState().mode === 'playing') return;
    const sources = activeGameSources(g.headers);
    const resolved = resolveUserSide(g.headers, sources, hooks.names());
    const batch = gameToBatch(g);
    void hooks.record({
      gameKey: gameKey(
        batch.startFen,
        batch.moves.map((m) => m.uci),
      ),
      startFen: g.startFen,
      moves: g.moves.map((m) => m.san),
      headers: ledgerHeaders(g.headers, gameUrl(g.headers)),
      source: resolved.source,
      ...(resolved.userSide ? { userSide: resolved.userSide } : {}),
      reviewedAt: hooks.now(),
    });
  });

  return () => {
    unwatchGame();
    unwatchPlay();
    unwatchLive();
    unwatchRoom();
    unwatchReview();
  };
}
