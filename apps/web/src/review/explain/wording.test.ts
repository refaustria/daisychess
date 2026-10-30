import { describe, expect, it } from 'vitest';
import {
  classLabelText,
  fitSentences,
  MAX_CHARS,
  moverEvalText,
  numberedLine,
  pieceOn,
} from './wording';

describe('moverEvalText', () => {
  it('signs centipawns from the mover’s side, one decimal, U+2212 minus', () => {
    expect(moverEvalText({ cp: 140 }, 'white')).toBe('+1.4');
    expect(moverEvalText({ cp: 140 }, 'black')).toBe('−1.4');
    expect(moverEvalText({ cp: -35 }, 'black')).toBe('+0.3');
    expect(moverEvalText({ cp: 4 }, 'white')).toBe('0.0');
    expect(moverEvalText({ cp: -4 }, 'white')).toBe('0.0');
  });

  it('names mates by the mating side', () => {
    expect(moverEvalText({ mate: 3 }, 'white')).toBe('mate in 3');
    expect(moverEvalText({ mate: -2 }, 'black')).toBe('mate in 2');
    expect(moverEvalText({ mate: 2 }, 'black')).toBe('mate in 2 for White');
    expect(moverEvalText({ mate: -1 }, 'white')).toBe('mate in 1 for Black');
    expect(moverEvalText({ mate: 0 }, 'white')).toBe('checkmate');
  });
});

describe('numberedLine', () => {
  it('numbers from the FEN, White or Black to move', () => {
    const w = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    expect(numberedLine(w, ['Nf3', 'Nc6', 'Bb5'])).toBe('2. Nf3 Nc6 3. Bb5');
    const b = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
    expect(numberedLine(b, ['Nc6', 'Bb5', 'a6'])).toBe('2... Nc6 3. Bb5 a6');
    expect(numberedLine(b, [])).toBe('');
  });
});

describe('labels', () => {
  it('classLabelText shows the loss when it rounds to ≥ 1%', () => {
    expect(classLabelText({ classification: 'blunder', winProbLoss: 41.4 })).toBe('Blunder (−41%)');
    expect(classLabelText({ classification: 'inaccuracy', winProbLoss: 0.4 })).toBe('Inaccuracy');
  });

  it('pieceOn names a unit and its square', () => {
    expect(pieceOn('n', 'e5')).toBe('the knight on e5');
  });
});

describe('fitSentences', () => {
  it('keeps at most three sentences', () => {
    expect(fitSentences(['a.', 'b.', 'c.', 'd.'])).toEqual(['a.', 'b.', 'c.']);
    expect(fitSentences(['a.', '', 'b.'])).toEqual(['a.', 'b.']);
  });

  it('drops trailing sentences until the total fits 280 characters', () => {
    const long = `${'x'.repeat(200)}.`;
    expect(fitSentences([long, long])).toEqual([long]);
  });

  it('cuts a single overlong sentence at a word boundary with an ellipsis', () => {
    const words = Array.from({ length: 80 }, () => 'word').join(' ');
    const [s] = fitSentences([words]);
    expect(s!.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(s!.endsWith('word…')).toBe(true);
  });
});
