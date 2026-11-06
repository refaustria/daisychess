import { materialSignature, type TbVerdict } from '@daisychess/endgames';
import { describe, expect, it } from 'vitest';
import { endgameStopCard, tbAfterPly, type EndgameCardInput } from './endgameStop';

// White: R + 2P + ... see each test; Black: R + 2P.
const ROOK_FEN = '6k1/5pp1/8/8/1P3PP1/8/6K1/R6r b - - 0 1'; // White R+3P, Black R+2P

const TEXT = { key: 'rook', title: 'Rook endgame', text: 'Rooks belong behind passed pawns.' };

function input(over: Partial<EndgameCardInput> = {}): EndgameCardInput {
  return {
    fen: ROOK_FEN,
    signature: materialSignature(ROOK_FEN),
    family: 'rook',
    familyText: TEXT,
    mover: 'white',
    ...over,
  };
}

describe('endgameStopCard', () => {
  it('builds title, signature, family text and the button data', () => {
    const card = endgameStopCard(input({ evalWhite: { cp: 30 } }));
    expect(card.kind).toBe('endgame');
    expect(card.title).toBe('Endgame: rook endgame');
    expect(card.signature).toBe('White: R+3P · Black: R+2P (White a pawn up)');
    expect(card.familyText).toBe(TEXT.text);
    expect(card.puzzleTheme).toBe('rookEndgame');
    expect(card.lessonFamily).toBe('rook_pawn');
  });

  it('names the pawn difference in words and omits it when equal', () => {
    const eq = '6k1/5pp1/8/8/5PP1/8/6K1/R6r b - - 0 1';
    expect(endgameStopCard(input({ fen: eq, signature: materialSignature(eq) })).signature).toBe(
      'White: R+2P · Black: R+2P',
    );
    const three = '6k1/8/8/8/1P3PP1/8/6K1/R6r b - - 0 1';
    expect(
      endgameStopCard(input({ fen: three, signature: materialSignature(three) })).signature,
    ).toContain('(White three pawns up)');
  });

  it('has a lesson family for king and pawn endings', () => {
    const fen = '8/8/4k3/8/4P3/4K3/8/8 w - - 0 1';
    const card = endgameStopCard({
      fen,
      signature: materialSignature(fen),
      family: 'kp_v_k',
      mover: 'black',
    });
    expect(card.lessonFamily).toBe('king_pawn');
    expect(card.puzzleTheme).toBe('pawnEndgame');
  });

  it('uses no placeholder without a family text', () => {
    const card = endgameStopCard(input({ familyText: undefined }));
    expect(card.title).toBe('Endgame');
    expect(card.familyText).toBeUndefined();
    expect(card.sentences).toEqual([]);
  });

  it.each([
    [{ cp: 30 }, 'The engine rates it +0.3: balanced.'],
    [{ cp: -120 }, 'The engine rates it −1.2 for Black: a slight edge.'],
    [{ cp: 180 }, 'The engine rates it +1.8 for White: winning chances, not yet a win.'],
    [{ cp: 400 }, 'The engine rates it +4.0 for White: winning.'],
    [{ mate: 5 }, 'The engine sees mate in 5 for White.'],
    [{ mate: -2 }, 'The engine sees mate in 2 for Black.'],
  ] as const)('engine band %j', (score, sentence) => {
    expect(endgameStopCard(input({ evalWhite: score })).sentences).toEqual([sentence]);
  });

  it('prefers the tablebase to the engine', () => {
    const card = endgameStopCard(
      input({ evalWhite: { cp: 400 }, tb: { result: 'white', mateIn: 23, exact50: true } }),
    );
    expect(card.sentences).toEqual(['Tablebase: White wins (mate in 23).']);
    expect(endgameStopCard(input({ tb: { result: 'draw', exact50: true } })).sentences).toEqual([
      'Tablebase: draw.',
    ]);
    expect(endgameStopCard(input({ tb: { result: 'draw', exact50: false } })).sentences).toEqual([
      'Tablebase: draw (50-move rule).',
    ]);
  });

  it('adds the result sentence only when verdict and result disagree', () => {
    const win = { cp: 400 };
    expect(endgameStopCard(input({ evalWhite: win, result: '0-1' })).sentences).toEqual([
      'The engine rates it +4.0 for White: winning.',
      'Black won the game nevertheless.',
    ]);
    expect(endgameStopCard(input({ evalWhite: win, result: '1-0' })).sentences).toHaveLength(1);
    expect(
      endgameStopCard(input({ tb: { result: 'draw', exact50: true }, result: '1-0' })).sentences.at(
        -1,
      ),
    ).toBe('White won the game nevertheless.');
    expect(endgameStopCard(input({ evalWhite: win, result: '1/2-1/2' })).sentences.at(-1)).toBe(
      'The game was drawn nevertheless.',
    );
    // an unsure engine verdict or an unfinished game claims nothing
    expect(endgameStopCard(input({ evalWhite: { cp: 180 }, result: '0-1' })).sentences).toHaveLength(
      1,
    );
    expect(endgameStopCard(input({ evalWhite: win, result: '*' })).sentences).toHaveLength(1);
  });
});

describe('tbAfterPly', () => {
  const v = (
    before: TbVerdict['before'],
    after: TbVerdict['after'],
    dtmBefore?: number,
  ): TbVerdict => ({
    uci: 'a1a2',
    san: 'Ra2',
    before,
    after,
    kind: 'kept',
    keepers: ['a1a2'],
    ...(dtmBefore !== undefined ? { dtmBefore } : {}),
  });

  it('reads the result before the next move, with the mate distance', () => {
    // ply 4 was played by White; at ply 5 Black to move is lost (dtm -5 plies: mate in 3)
    expect(tbAfterPly({ 5: v('loss', 'loss', -5) }, 4, 'white')).toEqual({
      result: 'white',
      exact50: true,
      mateIn: 3,
    });
  });

  it('falls back to the mover’s result after its own move', () => {
    expect(tbAfterPly({ 4: v('win', 'draw') }, 4, 'white')).toEqual({
      result: 'draw',
      exact50: true,
    });
    expect(tbAfterPly({ 4: v('win', 'win') }, 4, 'black')).toEqual({
      result: 'black',
      exact50: true,
    });
  });

  it('is undefined without verdicts', () => {
    expect(tbAfterPly(undefined, 4, 'white')).toBeUndefined();
    expect(tbAfterPly({}, 4, 'white')).toBeUndefined();
  });
});
