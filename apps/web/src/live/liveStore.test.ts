import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLichessAuth } from '../lichess/auth';
import { configurePlay, resetPlay, usePlayStore } from '../play/playStore';
import { FakePlayEngine } from '../play/fakePlayEngine';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { useUiStore } from '../store/uiStore';
import { BoardApiError } from './boardApi';
import { configureLive, resetLive, useLiveStore } from './liveStore';
import { humanGameLockReason, isHumanGameRunning } from './lock';
import { fakeBoardApi, flush, gameFull, gameState, type FakeBoardApi } from './testing';

let api: FakeBoardApi;
const l = () => useLiveStore.getState();
const tick = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function login(scopes = ['board:play', 'challenge:read', 'challenge:write']) {
  useLichessAuth.setState({ status: 'authenticated', token: 'tok', username: 'Me', scopes, error: undefined });
}

const gameStart = (gameId: string, color: 'white' | 'black' = 'white') => ({
  type: 'gameStart' as const,
  game: { gameId, color, opponent: { name: 'Opp' }, rated: true, speed: 'rapid' },
});

beforeEach(async () => {
  await configurePlay({ createEngine: () => new FakePlayEngine(), extraDelayMs: () => 0, random: () => 0.1 });
  api = fakeBoardApi();
  configureLive({ api, sleep: async () => undefined, seekGraceMs: 0 });
  login();
  useGameStore.getState().reset();
  useUiStore.setState({ activeTab: 'live' });
  useAnalysisStore.getState().setEnabled(true);
});

afterEach(async () => {
  resetLive();
  await resetPlay();
  useAnalysisStore.getState().setEnabled(false);
  useLichessAuth.setState({ status: 'anonymous', token: undefined, username: undefined, scopes: [] });
});

describe('connect', () => {
  it('requires a login with board:play', async () => {
    useLichessAuth.setState({ status: 'anonymous', token: undefined, username: undefined, scopes: [] });
    l().connect();
    login(['challenge:read']);
    l().connect();
    expect(api.calls).not.toContain('streamEvents');
    login();
    l().connect();
    await flush();
    expect(api.calls).toContain('streamEvents');
    expect(api.calls).toContain('ongoingGames');
  });

  it('reconnects the event stream after a drop; shows incoming challenges, not our own', async () => {
    l().setActive(true);
    await flush();
    const s = api.eventStreams[0]!;
    s.push({
      type: 'challenge',
      challenge: { id: 'c1234567', status: 'created', challenger: { id: 'bob', name: 'Bob' }, rated: false, speed: 'blitz', variant: 'standard', color: 'random' },
    });
    s.push({
      type: 'challenge',
      challenge: { id: 'c7654321', status: 'created', challenger: { id: 'me', name: 'Me' }, rated: false, speed: 'blitz', variant: 'standard', color: 'random' },
    });
    await flush();
    expect(l().challenges.map((c) => c.id)).toEqual(['c1234567']);
    expect(l().connection).toBe('online');
    s.end();
    await tick();
    expect(api.eventStreams).toHaveLength(2);
    api.eventStreams[1]!.push({
      type: 'challengeCanceled',
      challenge: { id: 'c1234567', status: 'canceled', challenger: { id: 'bob', name: 'Bob' }, rated: false, speed: 'blitz', variant: 'standard', color: 'random' },
    });
    await flush();
    expect(l().challenges).toEqual([]);
  });

  it('stops retrying on unauthorized', async () => {
    l().connect();
    await flush();
    api.eventStreams[0]!.fail(new BoardApiError('unauthorized', 'Log in again'));
    await tick();
    expect(api.eventStreams).toHaveLength(1);
    expect(l().error).toBe('Log in again');
    expect(l().connection).toBe('off');
  });
});

describe('seek', () => {
  it('seeks, locks the engine, joins the new game from gameStart and mirrors it', async () => {
    l().setActive(true);
    await flush();
    void l().seek({ rated: true, time: 10, increment: 0, color: 'random' });
    expect(l().status).toBe('seeking');
    expect(isHumanGameRunning()).toBe(true);
    expect(useAnalysisStore.getState().enabled).toBe(false);
    // Not bypassable: switching the analysis on is reverted at once.
    useAnalysisStore.getState().setEnabled(true);
    expect(useAnalysisStore.getState().enabled).toBe(false);

    useUiStore.setState({ activeTab: 'moves' });
    api.eventStreams[0]!.push(gameStart('game1234'));
    await flush();
    expect(l().status).toBe('playing');
    expect(api.seeks[0]!.cancelled).toBe(true);
    expect(useUiStore.getState().activeTab).toBe('live');
    expect(api.calls).toContain('streamGame game1234');
    api.gameStreams[0]!.push(gameFull({ moves: 'e2e4 e7e5' }));
    await flush();
    expect(l().game).toMatchObject({ id: 'game1234', color: 'white', moves: ['e2e4', 'e7e5'] });
    expect(useGameStore.getState().moves).toHaveLength(2);

    api.gameStreams[0]!.push(gameState('e2e4 e7e5 d1h5 b8c6 f1c4 g8f6 h5f7', { status: 'mate', winner: 'white' }));
    await flush();
    expect(l().status).toBe('finished');
    expect(isHumanGameRunning()).toBe(false);
    // The analysis comes back after the game.
    expect(useAnalysisStore.getState().enabled).toBe(true);
    l().leave();
    expect(l().status).toBe('idle');
  });

  it('ignores gameStart of games that existed before the seek (ongoing correspondence etc.)', async () => {
    l().connect();
    await flush();
    api.eventStreams[0]!.push(gameStart('old12345'));
    await flush();
    expect(l().ongoing.map((g) => g.gameId)).toEqual(['old12345']);
    expect(l().status).toBe('idle');
    void l().seek({ rated: false, time: 10, increment: 5, color: 'white' });
    api.eventStreams[0]!.push(gameStart('old12345'));
    await flush();
    expect(l().status).toBe('seeking');
  });

  it('cancelSeek aborts the seek and restores the analysis', async () => {
    void l().seek({ rated: true, time: 10, increment: 0, color: 'random' });
    await l().cancelSeek();
    expect(api.seeks[0]!.cancelled).toBe(true);
    expect(l().status).toBe('idle');
    expect(useAnalysisStore.getState().enabled).toBe(true);
  });

  it('a seek error returns to idle with the message', async () => {
    void l().seek({ rated: true, time: 10, increment: 0, color: 'random' });
    api.seeks[0]!.reject(new BoardApiError('rate_limited', 'slow down', { retryAfter: 60 }));
    await tick();
    expect(l().status).toBe('idle');
    expect(l().error).toBe('slow down');
  });
});

describe('challenges', () => {
  it('accept joins the challenge game; decline removes it', async () => {
    useLiveStore.setState({
      challenges: [
        { id: 'c1234567', status: 'created', challenger: { id: 'bob', name: 'Bob' }, rated: false, speed: 'blitz', variant: 'standard', color: 'white' },
        { id: 'c7654321', status: 'created', challenger: { id: 'eve', name: 'Eve' }, rated: false, speed: 'blitz', variant: 'standard', color: 'random' },
      ],
    });
    await l().decline('c7654321');
    expect(api.calls).toContain('decline c7654321');
    await l().accept('c1234567');
    expect(api.calls).toContain('accept c1234567');
    expect(l().status).toBe('playing');
    expect(l().challenges).toEqual([]);
    expect(api.calls).toContain('streamGame c1234567');
  });

  it('a declined outgoing challenge returns to idle with a notice', async () => {
    l().connect();
    await flush();
    await l().challengeUser('Bob', { clock: { limit: 300, increment: 3 }, rated: false, color: 'random' });
    expect(l().pending).toMatchObject({ kind: 'challenge', id: 'chal1234' });
    api.eventStreams[0]!.push({
      type: 'challengeDeclined',
      challenge: {
        id: 'chal1234',
        status: 'declined',
        challenger: { id: 'me', name: 'Me' },
        destUser: { id: 'bob', name: 'Bob' },
        rated: false,
        speed: 'blitz',
        variant: 'standard',
        color: 'random',
        declineReason: 'I am busy',
      },
    });
    await flush();
    expect(l().status).toBe('idle');
    expect(l().notice).toBe('Bob declined the challenge (I am busy)');
  });

  it('the lichess AI game starts right away', async () => {
    await l().challengeAi(3, { limit: 300, increment: 3 }, 'white');
    expect(api.calls).toContain('challengeAi 3');
    expect(l().status).toBe('playing');
    expect(api.calls).toContain('streamGame aigame12');
  });
});

describe('game actions', () => {
  async function playing() {
    l().resume('game1234');
    await flush();
    api.gameStreams[0]!.push(gameFull({ moves: 'e2e4 e7e5' }));
    await flush();
  }

  it('resign, abort, draw and claim go to the current game', async () => {
    await playing();
    await l().offerDraw();
    await l().declineDraw();
    await l().acceptDraw();
    await l().abort();
    await l().claimVictory();
    await l().resign();
    expect(api.calls.filter((c) => /^(draw|abort|claim|resign)/.test(c))).toEqual([
      'draw game1234 yes',
      'draw game1234 no',
      'draw game1234 yes',
      'abort game1234',
      'claimVictory game1234',
      'resign game1234',
    ]);
  });

  it('move() plays the user move at the tip and sends it', async () => {
    await playing();
    expect(l().move('g1f3')).toBe(true);
    await flush();
    expect(api.calls).toContain('move game1234 g1f3');
    expect(l().move('b8c6')).toBe(false); // not our turn
  });

  it('logout during a game ends it here with an error and unlocks', async () => {
    await playing();
    useLichessAuth.setState({ status: 'anonymous', token: undefined, username: undefined, scopes: [] });
    expect(l().status).toBe('error');
    expect(isHumanGameRunning()).toBe(false);
  });
});

describe('lock interplay with the local engine game', () => {
  it('a live game cannot start while a game against the engine runs', async () => {
    usePlayStore.getState().start({ color: 'white' });
    expect(humanGameLockReason()).toBe('engine');
    await l().seek({ rated: true, time: 10, increment: 0, color: 'random' });
    expect(l().status).toBe('idle');
    expect(l().error).toMatch(/engine first/);
    expect(api.seeks).toHaveLength(0);
  });

  it('a game against the engine cannot start during a live game', async () => {
    l().resume('game1234');
    expect(humanGameLockReason()).toBe('live');
    usePlayStore.getState().start({ color: 'white' });
    expect(usePlayStore.getState().mode).toBe('idle');
    expect(usePlayStore.getState().message).toMatch(/live game/);
  });
});
