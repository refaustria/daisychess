import { create } from 'zustand';
import { hasScope, useLichessAuth } from '../lichess/auth';
import { setPlayStartGuard, usePlayStore } from '../play/playStore';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import {
  BoardApiError,
  createBoardApi,
  isAbortError,
  type BoardApi,
  type ChallengeInfo,
  type ClockParams,
  type GameInfo,
  type LichessEvent,
  type SeekHandle,
  type SeekParams,
} from './boardApi';
import { LiveGameController, reconnectDelay, type LiveGame } from './LiveGameController';

export type LiveStatus = 'idle' | 'seeking' | 'playing' | 'finished' | 'error';
export type ColorChoice = 'white' | 'black' | 'random';

export const BOARD_SCOPE = 'board:play';
export const FAIR_PLAY_TEXT = 'Disabled during a live game (lichess fair play)';

/** An incoming challenge (someone challenges the user). */
export type IncomingChallenge = ChallengeInfo;
export type OngoingGame = GameInfo;

/** What the user is waiting for while `status === 'seeking'`. */
export type Pending =
  | { kind: 'seek'; label: string }
  | { kind: 'challenge'; id?: string; label: string }
  | { kind: 'ai'; id?: string; label: string }
  | { kind: 'accept'; id: string; label: string };

export interface LiveState {
  status: LiveStatus;
  game?: LiveGame;
  pending?: Pending;
  challenges: IncomingChallenge[];
  ongoing: OngoingGame[];
  /** Event stream state. */
  connection: 'off' | 'connecting' | 'online' | 'retrying';
  /** Premoves (UCI) waiting for the user's turn, in order (one in `single` mode). */
  premoves: string[];
  error?: string;
  /** Short informational text (declined challenge, no opponent found). */
  notice?: string;
}

export interface LiveActions {
  /** The Live panel is shown (connects) or hidden (disconnects unless a game is on). */
  setActive(active: boolean): void;
  connect(): void;
  disconnect(): void;
  seek(params: SeekParams): Promise<void>;
  cancelSeek(): Promise<void>;
  challengeUser(username: string, opts: { clock: ClockParams; rated: boolean; color: ColorChoice }): Promise<void>;
  challengeAi(level: number, clock: ClockParams, color?: ColorChoice): Promise<void>;
  accept(id: string): Promise<void>;
  decline(id: string): Promise<void>;
  resume(gameId: string): void;
  move(uci: string): boolean;
  /** Adds a premove (replaces the current one in `single` mode, ignored in `none`). */
  addPremove(uci: string): void;
  clearPremoves(): void;
  resign(): Promise<void>;
  abort(): Promise<void>;
  offerDraw(): Promise<void>;
  acceptDraw(): Promise<void>;
  declineDraw(): Promise<void>;
  claimVictory(): Promise<void>;
  /** Back to the setup after a finished game (or an error). */
  leave(): void;
  clearMessages(): void;
}

export type LiveStore = LiveState & LiveActions;

interface LiveHooks {
  api: BoardApi;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** How long to wait for `gameStart` after lichess closed a seek. */
  seekGraceMs: number;
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

const defaultHooks = (): LiveHooks => ({
  api: createBoardApi(),
  now: () => Date.now(),
  sleep: realSleep,
  seekGraceMs: 5000,
});

let hooks: LiveHooks = defaultHooks();
let controller: LiveGameController | null = null;
let events: AbortController | null = null;
let seekHandle: SeekHandle | null = null;
/** Games this page saw finish (the event stream resends `gameStart` for them on reconnect). */
const finishedIds = new Set<string>();
/** Ongoing game ids when a seek started (only a new game is the seek's). */
let knownAtSeek = new Set<string>();
let panelActive = false;
let analysisSuspended = false;
let unwatchAnalysis: (() => void) | null = null;

const LOCKED: ReadonlySet<LiveStatus> = new Set(['seeking', 'playing']);
export const isLiveLocked = (s: Pick<LiveState, 'status'>): boolean => LOCKED.has(s.status);

const message = (e: unknown): string =>
  e instanceof BoardApiError ? e.message : e instanceof Error ? e.message : 'Request to lichess failed';

const PLAY_RUNNING_TEXT = 'Finish or stop the game against the engine first';
const LIVE_RUNNING_TEXT = 'Finish the live game on lichess first';

// --- engine lock: live analysis off while seeking/playing --------------------------------------

function suspendAnalysis(): void {
  const a = useAnalysisStore.getState();
  if (a.enabled) {
    analysisSuspended = true;
    a.setEnabled(false);
  }
  // Not bypassable: any attempt to switch it on during the game is reverted at once.
  unwatchAnalysis ??= useAnalysisStore.subscribe((s) => {
    if (s.enabled && isLiveLocked(useLiveStore.getState())) {
      analysisSuspended = true;
      s.setEnabled(false);
    }
  });
}

function restoreAnalysis(): void {
  unwatchAnalysis?.();
  unwatchAnalysis = null;
  if (!analysisSuspended) return;
  analysisSuspended = false;
  // A local engine game may have started in the meantime; it keeps its own pause.
  if (usePlayStore.getState().mode === 'playing') return;
  if (!useAnalysisStore.getState().enabled) useAnalysisStore.getState().setEnabled(true);
}

// --- helpers -------------------------------------------------------------------------------------

const myName = (): string | undefined => useLichessAuth.getState().username;

function canPlay(): string | null {
  if (!hasScope(BOARD_SCOPE)) return 'Log in with lichess (with the board:play permission) to play live games';
  if (usePlayStore.getState().mode === 'playing') return PLAY_RUNNING_TEXT;
  return null;
}

function upsertOngoing(list: OngoingGame[], g: GameInfo): OngoingGame[] {
  return [...list.filter((x) => x.gameId !== g.gameId), g];
}

function stopController(): void {
  controller?.dispose();
  controller = null;
}

function stopSeek(): void {
  seekHandle?.cancel();
  seekHandle = null;
}

function onEvent(ev: LichessEvent): void {
  const set = useLiveStore.setState;
  const s = useLiveStore.getState();
  const me = myName()?.toLowerCase();
  switch (ev.type) {
    case 'gameStart': {
      const g = ev.game;
      if (finishedIds.has(g.gameId)) return;
      if (s.game?.id === g.gameId && (s.status === 'playing' || s.status === 'finished')) return;
      set({ ongoing: upsertOngoing(s.ongoing, g) });
      const p = s.status === 'seeking' ? s.pending : undefined;
      const ours =
        p !== undefined &&
        ('id' in p && p.id !== undefined
          ? p.id === g.gameId
          : p.kind === 'seek' && !knownAtSeek.has(g.gameId) && g.speed !== 'correspondence');
      if (ours) join(g.gameId, g.color);
      return;
    }
    case 'gameFinish':
      finishedIds.add(ev.game.gameId);
      set({ ongoing: s.ongoing.filter((x) => x.gameId !== ev.game.gameId) });
      return;
    case 'challenge': {
      const c = ev.challenge;
      if (c.challenger.id === me) return; // our own outgoing challenge
      if (c.status !== 'created' && c.status !== 'offline') return;
      set({ challenges: [...s.challenges.filter((x) => x.id !== c.id), c] });
      return;
    }
    case 'challengeCanceled':
      set({ challenges: s.challenges.filter((x) => x.id !== ev.challenge.id) });
      if (s.status === 'seeking' && s.pending && 'id' in s.pending && s.pending.id === ev.challenge.id) {
        set({ status: 'idle', pending: undefined, notice: 'The challenge was cancelled' });
      }
      return;
    case 'challengeDeclined': {
      const c = ev.challenge;
      set({ challenges: s.challenges.filter((x) => x.id !== c.id) });
      if (s.status === 'seeking' && s.pending?.kind === 'challenge' && s.pending.id === c.id) {
        const who = c.destUser?.name ?? 'Your opponent';
        set({
          status: 'idle',
          pending: undefined,
          notice: `${who} declined the challenge${c.declineReason ? ` (${c.declineReason})` : ''}`,
        });
      }
      return;
    }
  }
}

async function eventLoop(signal: AbortSignal): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    useLiveStore.setState({ connection: attempt === 0 ? 'connecting' : 'retrying' });
    try {
      void refreshOngoing();
      for await (const ev of hooks.api.streamEvents(signal)) {
        if (attempt !== 0 || useLiveStore.getState().connection !== 'online') useLiveStore.setState({ connection: 'online' });
        attempt = 0;
        onEvent(ev);
      }
      if (useLiveStore.getState().connection === 'connecting') useLiveStore.setState({ connection: 'online' });
    } catch (e) {
      if (signal.aborted || isAbortError(e)) return;
      if (e instanceof BoardApiError && e.kind === 'unauthorized') {
        useLiveStore.setState({ connection: 'off', error: e.message });
        if (events?.signal === signal) events = null;
        return;
      }
      if (e instanceof BoardApiError && e.kind === 'rate_limited') {
        await hooks.sleep((e.retryAfter ?? 60) * 1000, signal);
        continue;
      }
    }
    if (signal.aborted) return;
    useLiveStore.setState({ connection: 'retrying' });
    await hooks.sleep(reconnectDelay(attempt++), signal);
  }
}

async function refreshOngoing(): Promise<void> {
  try {
    const list = await hooks.api.ongoingGames();
    useLiveStore.setState({ ongoing: list.filter((g) => !finishedIds.has(g.gameId)) });
  } catch {
    // The list is a convenience; the event stream announces games too.
  }
}

/** Joins game `id`: the live game takes over the board and locks the engine. */
function join(id: string, colorHint?: 'white' | 'black'): void {
  if (controller?.gameId === id) return;
  stopController();
  stopSeek();
  // A live game always wins over a local engine game (it has a real opponent and a clock).
  if (usePlayStore.getState().mode === 'playing') usePlayStore.getState().stop();
  useLiveStore.setState({
    status: 'playing',
    pending: undefined,
    game: undefined,
    premoves: [],
    error: undefined,
    notice: undefined,
  });
  suspendAnalysis();
  const ctl = new LiveGameController({
    api: hooks.api,
    game: useGameStore,
    gameId: id,
    username: myName(),
    ...(colorHint ? { colorHint } : {}),
    now: hooks.now,
    sleep: hooks.sleep,
    onChange: (game) => {
      if (controller === ctl) useLiveStore.setState({ game });
    },
    onFinish: (game) => {
      if (controller !== ctl) return;
      finishedIds.add(game.id);
      const s = useLiveStore.getState();
      useLiveStore.setState({
        status: 'finished',
        game,
        premoves: [],
        ongoing: s.ongoing.filter((g) => g.gameId !== game.id),
      });
      restoreAnalysis();
    },
    onError: (msg) => {
      if (controller === ctl) useLiveStore.setState({ error: msg });
    },
    premoveMode: () => useSettingsStore.getState().premoves,
    onPremoves: (list) => {
      if (controller === ctl) useLiveStore.setState({ premoves: [...list] });
    },
  });
  controller = ctl;
  const ui = useUiStore.getState();
  if (ui.activeTab !== 'live') ui.setActiveTab('live');
  void ctl.start();
  if (!events) useLiveStore.getState().connect();
}

/** Sets an error and leaves the seeking state (no game). */
function failPending(e: unknown): void {
  stopSeek();
  useLiveStore.setState({ status: 'idle', pending: undefined, error: message(e) });
  restoreAnalysis();
}

function beginPending(pending: Pending): boolean {
  const blocked = canPlay();
  const s = useLiveStore.getState();
  if (blocked) {
    useLiveStore.setState({ error: blocked });
    return false;
  }
  if (s.status === 'seeking' || s.status === 'playing') return false;
  if (!events) s.connect();
  useLiveStore.setState({ status: 'seeking', pending, error: undefined, notice: undefined });
  suspendAnalysis();
  return true;
}

async function gameAction(fn: (api: BoardApi, id: string) => Promise<void>): Promise<void> {
  const s = useLiveStore.getState();
  if (s.status !== 'playing' || !s.game) return;
  try {
    await fn(hooks.api, s.game.id);
  } catch (e) {
    useLiveStore.setState({ error: message(e) });
  }
}

// --- store ---------------------------------------------------------------------------------------

export const useLiveStore = create<LiveStore>()((set, get) => ({
  status: 'idle',
  challenges: [],
  ongoing: [],
  premoves: [],
  connection: 'off',

  setActive: (active) => {
    panelActive = active;
    if (active) get().connect();
    else if (!isLiveLocked(get())) get().disconnect();
  },

  connect: () => {
    if (events) return;
    if (!hasScope(BOARD_SCOPE)) return;
    const ctl = new AbortController();
    events = ctl;
    void eventLoop(ctl.signal).finally(() => {
      if (events === ctl) {
        events = null;
        set({ connection: 'off' });
      }
    });
  },

  disconnect: () => {
    events?.abort();
    events = null;
    set({ connection: 'off' });
  },

  seek: async (params) => {
    const label = `${params.time}+${params.increment} ${params.rated ? 'rated' : 'casual'}`;
    if (!beginPending({ kind: 'seek', label })) return;
    knownAtSeek = new Set(get().ongoing.map((g) => g.gameId));
    const handle = hooks.api.seek(params);
    seekHandle = handle;
    try {
      await handle.done;
    } catch (e) {
      if (seekHandle === handle) failPending(e);
      return;
    }
    if (seekHandle !== handle) return;
    // lichess closed the seek: normally because a game started (announced by the event stream).
    const ctl = new AbortController();
    await hooks.sleep(hooks.seekGraceMs, ctl.signal);
    if (seekHandle === handle && get().status === 'seeking') {
      seekHandle = null;
      set({ status: 'idle', pending: undefined, notice: 'No opponent found – try again' });
      restoreAnalysis();
    }
  },

  cancelSeek: async () => {
    const s = get();
    if (s.status !== 'seeking') return;
    const p = s.pending;
    stopSeek();
    set({ status: 'idle', pending: undefined });
    restoreAnalysis();
    if (p?.kind === 'challenge' && p.id) {
      try {
        await hooks.api.cancelChallenge(p.id);
      } catch (e) {
        set({ error: message(e) });
      }
    }
  },

  challengeUser: async (username, opts) => {
    const name = username.trim();
    if (!name) {
      set({ error: 'Enter a lichess username' });
      return;
    }
    if (name.toLowerCase() === myName()?.toLowerCase()) {
      set({ error: 'You cannot challenge yourself' });
      return;
    }
    if (!beginPending({ kind: 'challenge', label: `Sending the challenge to ${name}…` })) return;
    try {
      const c = await hooks.api.challengeUser(name, { rated: opts.rated, clock: opts.clock, color: opts.color });
      if (get().status !== 'seeking') {
        void hooks.api.cancelChallenge(c.id).catch(() => undefined);
        return;
      }
      set({ pending: { kind: 'challenge', id: c.id, label: `Waiting for ${c.destUser?.name ?? name} to accept…` } });
    } catch (e) {
      failPending(e);
    }
  },

  challengeAi: async (level, clock, color = 'random') => {
    if (!beginPending({ kind: 'ai', label: `Starting a game against lichess AI level ${level}…` })) return;
    try {
      const id = await hooks.api.challengeAi(level, clock, color);
      if (get().status !== 'seeking') return;
      join(id);
    } catch (e) {
      failPending(e);
    }
  },

  accept: async (id) => {
    const c = get().challenges.find((x) => x.id === id);
    if (!beginPending({ kind: 'accept', id, label: `Accepting ${c?.challenger.name ?? 'the'} challenge…` })) return;
    set({ challenges: get().challenges.filter((x) => x.id !== id) });
    try {
      await hooks.api.acceptChallenge(id);
      if (get().status === 'seeking') join(id, c?.color === 'white' ? 'black' : c?.color === 'black' ? 'white' : undefined);
    } catch (e) {
      failPending(e);
    }
  },

  decline: async (id) => {
    set({ challenges: get().challenges.filter((x) => x.id !== id) });
    try {
      await hooks.api.declineChallenge(id);
    } catch (e) {
      set({ error: message(e) });
    }
  },

  resume: (gameId) => {
    const s = get();
    if (s.status === 'playing' || s.status === 'seeking') return;
    const blocked = canPlay();
    if (blocked) {
      set({ error: blocked });
      return;
    }
    const g = s.ongoing.find((x) => x.gameId === gameId);
    join(gameId, g?.color);
  },

  move: (uci) => controller?.playMove(uci) ?? false,

  addPremove: (uci) => {
    if (get().status !== 'playing') return;
    controller?.addPremove(uci);
  },

  clearPremoves: () => controller?.clearPremoves(),

  resign: () => gameAction((api, id) => api.resign(id)),
  abort: () => gameAction((api, id) => api.abort(id)),
  offerDraw: () => gameAction((api, id) => api.draw(id, true)),
  acceptDraw: () => gameAction((api, id) => api.draw(id, true)),
  declineDraw: () => gameAction((api, id) => api.draw(id, false)),
  claimVictory: () => gameAction((api, id) => api.claimVictory(id)),

  leave: () => {
    const s = get();
    if (s.status === 'playing' || s.status === 'seeking') return;
    stopController();
    set({ status: 'idle', game: undefined, premoves: [], error: undefined, notice: undefined });
    if (!panelActive) get().disconnect();
  },

  clearMessages: () => set({ error: undefined, notice: undefined }),
}));

// A local engine game cannot start while a live game runs (or a seek is pending).
setPlayStartGuard(() => (isLiveLocked(useLiveStore.getState()) ? LIVE_RUNNING_TEXT : null));

// Logged out (or the token was revoked): stop the streams; a running game cannot continue.
useLichessAuth.subscribe((a, prev) => {
  if (a.status === prev.status && a.token === prev.token) return;
  if (hasScope(BOARD_SCOPE)) {
    if (panelActive || isLiveLocked(useLiveStore.getState())) useLiveStore.getState().connect();
    return;
  }
  useLiveStore.getState().disconnect();
  const s = useLiveStore.getState();
  if (isLiveLocked(s)) {
    stopSeek();
    stopController();
    useLiveStore.setState({
      status: 'error',
      pending: undefined,
      error: 'Logged out of lichess – the live game cannot continue here',
    });
    restoreAnalysis();
  }
});

/** Test seam: replaces the api/clock/sleep and resets the store. */
export function configureLive(next: Partial<LiveHooks>): void {
  resetLive();
  hooks = { ...hooks, ...next };
}

/** Stops streams and the game and restores the defaults (tests). */
export function resetLive(): void {
  stopSeek();
  stopController();
  events?.abort();
  events = null;
  finishedIds.clear();
  knownAtSeek = new Set();
  panelActive = false;
  unwatchAnalysis?.();
  unwatchAnalysis = null;
  analysisSuspended = false;
  hooks = defaultHooks();
  useLiveStore.setState({
    status: 'idle',
    game: undefined,
    pending: undefined,
    challenges: [],
    ongoing: [],
    connection: 'off',
    premoves: [],
    error: undefined,
    notice: undefined,
  });
}
