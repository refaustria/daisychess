import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MaiaOpponent } from '../maia/opponent';
import { FakeMaiaServer, MAIA_WELCOME } from '../maia/opponentTesting';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { FakePlayEngine } from './fakePlayEngine';
import {
  configurePlay,
  PLAY_STORAGE_KEY,
  readPlaySetup,
  resetPlay,
  usePlayStore,
  type HumanEngineContext,
} from './playStore';
import {
  DEFAULT_MAIA,
  findStrength,
  HUMAN_PRESETS,
  isHumanStrength,
  strengthOptions,
} from './strength';

const g = () => useGameStore.getState();
const p = () => usePlayStore.getState();
const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

const okProbe = () =>
  useAnalysisStore.setState({
    serverProbe: { status: 'ok', engines: MAIA_WELCOME.engines, lastProbe: Date.now() },
  });

let stockfish: FakePlayEngine;
let server: FakeMaiaServer;
let contexts: HumanEngineContext[];
let maias: MaiaOpponent[];

beforeEach(async () => {
  stockfish = new FakePlayEngine();
  server = new FakeMaiaServer();
  contexts = [];
  maias = [];
  await configurePlay({
    createEngine: () => stockfish,
    createHumanEngine: (ctx) => {
      contexts.push(ctx);
      const m = new MaiaOpponent({
        engineId: ctx.engineId,
        createClient: () => server.client(ctx.engineId),
        varyMoves: ctx.varyMoves,
        remainingMs: ctx.remainingMs,
        wait: () => Promise.resolve(),
      });
      maias.push(m);
      return m;
    },
    extraDelayMs: () => 0,
    random: () => 0.1,
  });
  usePlayStore.setState({ setup: { color: 'white', strength: '1500', moveTime: 500 } });
  g().reset();
  okProbe();
});

afterEach(async () => {
  await resetPlay();
  useAnalysisStore.setState({ serverProbe: { status: 'idle' } });
});

describe('strength presets (Maia)', () => {
  it('human presets: maia-1100 … maia-1900, no UCI options', () => {
    expect(HUMAN_PRESETS.map((x) => x.id)).toEqual([
      'maia-1100',
      'maia-1200',
      'maia-1300',
      'maia-1400',
      'maia-1500',
      'maia-1600',
      'maia-1700',
      'maia-1800',
      'maia-1900',
    ]);
    expect(findStrength(DEFAULT_MAIA)).toEqual({
      id: 'maia-1500',
      label: 'Maia 1500',
      human: { rating: 1500 },
    });
    expect(isHumanStrength('maia-1500')).toBe(true);
    expect(isHumanStrength('1500')).toBe(false);
    expect(strengthOptions(findStrength('maia-1500'))).toEqual({});
    expect(findStrength('maia-2500').id).toBe('1500'); // unknown → default Stockfish preset
  });
});

describe('playStore vs Maia', () => {
  it('a game vs Maia 1500: the server engine answers 1.e4, Stockfish is not used', async () => {
    server.replies = [{ kind: 'move', best: 'e7e5', policy: [{ uci: 'e7e5', p: 0.6 }] }];
    p().start({ color: 'white', strength: 'maia-1500' });
    expect(p().mode).toBe('playing');
    expect(g().makeMove('e2', 'e4')).toBe(true);
    await flush();
    expect(g().moves.map((m) => m.san)).toEqual(['e4', 'e5']);
    expect(server.analyzes).toEqual([{ engine: 'maia-1500', fen: g().moves[0]!.fen }]);
    expect(contexts.map((c) => c.engineId)).toEqual(['maia-1500']);
    expect(stockfish.searches).toHaveLength(0);
    expect(p().thinking).toBe(false);
  });

  it('switching Maia → Stockfish disposes the Maia session and uses the browser engine', async () => {
    server.replies = [{ kind: 'move', best: 'e7e5' }];
    p().start({ color: 'white', strength: 'maia-1500' });
    g().makeMove('e2', 'e4');
    await flush();
    p().stop();
    p().start({ color: 'white', strength: '1800' });
    g().makeMove('e2', 'e4');
    await flush();
    expect(stockfish.searches).toHaveLength(1);
    expect(stockfish.options).toEqual([{ UCI_LimitStrength: true, UCI_Elo: 1800 }]);
    expect(server.sockets[0]!.ofType('release')).toHaveLength(1);
  });

  it('"Vary moves" is read per move from the setup', async () => {
    p().start({ color: 'white', strength: 'maia-1500', varyMoves: false });
    expect(contexts).toHaveLength(0);
    g().makeMove('e2', 'e4');
    await flush();
    expect(contexts[0]!.varyMoves()).toBe(false);
    p().setSetup({ varyMoves: true });
    expect(contexts[0]!.varyMoves()).toBe(true);
  });

  it('the remaining clock time reaches the opponent (think delay cap)', async () => {
    let now = 0;
    await configurePlay({ now: () => now });
    server.replies = [{ kind: 'move', best: 'e7e5' }];
    p().start({
      color: 'white',
      strength: 'maia-1500',
      timeControl: { initialMs: 60_000, incrementMs: 0 },
    });
    now = 1_000;
    g().makeMove('e2', 'e4');
    await flush();
    expect(contexts[0]!.remainingMs()).toBeLessThanOrEqual(60_000);
    expect(contexts[0]!.remainingMs()).toBeGreaterThan(0);
  });

  it('no_capacity three times: the game ends with "Maia is busy, try again"', async () => {
    server.replies = [{ kind: 'busy' }];
    p().start({ color: 'white', strength: 'maia-1500' });
    g().makeMove('e2', 'e4');
    await flush();
    expect(p()).toMatchObject({
      mode: 'finished',
      reason: 'engine_error',
      message: 'Maia is busy, try again',
    });
    expect(server.analyzes).toHaveLength(4);
    // Switching to Stockfish continues the same game from the position.
    p().start({ from: 'current', strength: '1500' });
    expect(p().mode).toBe('playing');
    await flush();
    expect(g().moves).toHaveLength(2);
    expect(stockfish.searches).toHaveLength(1);
  });

  it('known missing token: start is refused with the reason (setup kept)', () => {
    useAnalysisStore.setState({
      serverProbe: {
        status: 'error',
        error: 'Access token required or wrong',
        lastProbe: Date.now(),
      },
    });
    p().start({ color: 'white', strength: 'maia-1500' });
    expect(p().mode).toBe('idle');
    expect(p().message).toBe('Maia 1500 cannot play: Needs the server access token.');
    expect(p().setup.strength).toBe('maia-1500');
  });

  it('server unavailable / no Maia on the server: start is refused', () => {
    useAnalysisStore.setState({
      serverProbe: { status: 'error', error: 'Server unreachable', lastProbe: Date.now() },
    });
    p().start({ strength: 'maia-1500' });
    expect(p().message).toBe('Maia 1500 cannot play: Server unavailable.');
    useAnalysisStore.setState({
      serverProbe: { status: 'ok', engines: MAIA_WELCOME.engines.slice(0, 2), lastProbe: 1 },
    });
    p().start({ strength: 'maia-1500' });
    expect(p().message).toBe('Maia 1500 cannot play: Not offered by the server.');
    expect(p().mode).toBe('idle');
  });

  it('token missing found only at connect (probe pending): the game ends with the reason', async () => {
    useAnalysisStore.setState({ serverProbe: { status: 'idle' } });
    server.welcome = {
      ...MAIA_WELCOME,
      engines: [],
      capabilities: { analysis: false, rooms: true },
    };
    p().start({ color: 'black', strength: 'maia-1500' });
    expect(p().mode).toBe('playing');
    await flush();
    expect(p()).toMatchObject({
      mode: 'finished',
      reason: 'engine_error',
      message: 'Needs the server access token',
    });
  });

  it('persists the Maia choice and "Vary moves"', () => {
    p().setSetup({ strength: 'maia-1100', varyMoves: false });
    expect(JSON.parse(localStorage.getItem(PLAY_STORAGE_KEY)!)).toMatchObject({
      strength: 'maia-1100',
      varyMoves: false,
    });
    expect(readPlaySetup()).toMatchObject({ strength: 'maia-1100', varyMoves: false });
    localStorage.setItem(PLAY_STORAGE_KEY, JSON.stringify({ strength: 'maia-1500' }));
    expect(readPlaySetup()).toMatchObject({ strength: 'maia-1500', varyMoves: true });
  });
});
