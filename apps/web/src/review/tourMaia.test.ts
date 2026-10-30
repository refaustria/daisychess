// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMaiaHints, useMaiaHintStore } from '../maia/hintStore';
import type { MaiaHint } from '../maia/hints';
import { useGameStore } from '../store/gameStore';
import { buildMoveDetails } from './details';
import { gameToBatch, useReviewStore } from './reviewStore';
import { scholarSummary } from './testFixtures';
import { setTourTimer, setTourUserSide, useTourStore } from './tourStore';

const PGN = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';
const hint = (playedIsTop: boolean): MaiaHint => ({
  ply: 6,
  rating: 1500,
  top: [{ uci: 'g8f6', san: 'Nf6', p: 0.38 }],
  playedIsTop,
  entries: 1,
});

let fire: () => void = () => undefined;
beforeEach(() => {
  setTourUserSide(async () => 'white');
  useGameStore.getState().loadPgn(PGN);
  const summary = scholarSummary();
  const moveDetails = buildMoveDetails(
    summary,
    gameToBatch(useGameStore.getState()),
    Array.from({ length: 8 }, () => ({})),
  );
  useReviewStore.setState({ status: 'done', summary, moveDetails });
  let pending: (() => void) | undefined;
  setTourTimer({ set: (fn) => (pending = fn), clear: () => (pending = undefined) });
  fire = () => {
    const p = pending;
    pending = undefined;
    p?.();
  };
});
afterEach(() => {
  useTourStore.getState().stop();
  setTourTimer(undefined);
  setTourUserSide(undefined);
  resetMaiaHints();
});

const level = { rating: 1500, source: 'setting' as const };

describe('guided tour with Maia hints', () => {
  it('appends "common at 1500" to a mistake that is Maia\'s top move', async () => {
    useMaiaHintStore.setState({
      status: 'done',
      forMoves: useGameStore.getState().moves,
      levels: { white: level, black: level },
      hints: { 6: hint(true) },
    });
    await useTourStore.getState().start();
    for (let i = 0; i < 3; i++) fire();
    useTourStore.getState().next(); // past the opening stop
    fire();
    expect(useGameStore.getState().ply).toBe(6);
    expect(useTourStore.getState().text).toMatch(/^3\.\.\. Nf6\?\? Blunder.* — common at 1500$/);
    // As a stop of the user's side: the mistake card carries the same line.
    await useTourStore.getState().start('black');
    useTourStore.getState().skip();
    useTourStore.getState().skip();
    const card = useTourStore.getState().card;
    expect(card?.kind === 'mistake' && card.text).toMatch(/ — common at 1500$/);
  });

  it('no suffix for an unusual mistake or hints of another game', async () => {
    useMaiaHintStore.setState({
      status: 'done',
      forMoves: [],
      levels: { white: level, black: level },
      hints: { 6: hint(true) },
    });
    await useTourStore.getState().start('black');
    useTourStore.getState().skip();
    useTourStore.getState().skip();
    expect(useGameStore.getState().ply).toBe(6);
    expect(useTourStore.getState().text).not.toContain('common');
    useMaiaHintStore.setState({ forMoves: useGameStore.getState().moves, hints: { 6: hint(false) } });
    await useTourStore.getState().start('black');
    useTourStore.getState().skip();
    useTourStore.getState().skip();
    expect(useGameStore.getState().ply).toBe(6);
    expect(useTourStore.getState().text).not.toContain('common');
  });
});
