import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { OpeningFocus } from './openingFocus';
import { openingStopCard } from './openingStop';

const ITALIAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Nc3', 'Bc5'];

describe('openingStopCard', () => {
  it('left the book with alternatives: title, family text, sentences, preview', () => {
    const focus: OpeningFocus = {
      openingName: 'Italian Game: Two Knights Defense',
      eco: 'C55',
      lastBookPly: 6,
      leftBy: 'white',
      leavePly: 7,
      bookMoveInstead: [
        { san: 'd3', name: 'Italian Game: Giuoco Pianissimo' },
        { san: 'c3', name: 'Italian Game: Giuoco Piano' },
      ],
      evalSwingAtLeave: -0.4,
    };
    const card = openingStopCard(focus, ITALIAN, { text: 'Family text.' });
    expect(card.kind).toBe('opening');
    expect(card.title).toBe('Opening: Italian Game: Two Knights Defense (C55)');
    expect(card.familyText).toBe('Family text.');
    expect(card.sentences).toEqual([
      'Book until move 3 (…Nf6).',
      'White left the book with 4. Nc3; the book plays d3 (Giuoco Pianissimo) or c3 (Giuoco Piano). The deviation cost 0.4.',
    ]);
    const chess = new Chess();
    for (const m of ITALIAN.slice(0, 6)) chess.move(m);
    expect(card.preview).toEqual({ fen: chess.fen(), sans: ['d3'] });
  });

  it('shows the mover POV for Black and a gain', () => {
    const focus: OpeningFocus = {
      openingName: 'Italian Game',
      eco: 'C50',
      lastBookPly: 7,
      leftBy: 'black',
      leavePly: 8,
      bookMoveInstead: [{ san: 'Bc5' }],
      evalSwingAtLeave: -0.6,
    };
    const card = openingStopCard(focus, [...ITALIAN.slice(0, 7), 'h6']);
    expect(card.sentences[1]).toBe(
      'Black left the book with 4... h6; the book plays Bc5. The deviation gained 0.6.',
    );
    expect(card.familyText).toBeUndefined();
  });

  it('omits a tiny deviation cost', () => {
    const focus: OpeningFocus = {
      lastBookPly: 4,
      leftBy: 'white',
      leavePly: 5,
      bookMoveInstead: [{ san: 'Bc4' }],
      evalSwingAtLeave: -0.05,
    };
    const card = openingStopCard(focus, ['e4', 'e5', 'Nf3', 'Nc6', 'a3']);
    expect(card.sentences.at(-1)).toBe('White left the book with 3. a3; the book plays Bc4.');
    expect(card.title).toBe('Opening');
  });

  it('book line ended', () => {
    const focus: OpeningFocus = {
      openingName: 'Italian Game',
      eco: 'C50',
      lastBookPly: 5,
      leftBy: 'black',
      leavePly: 6,
      endOfBook: true,
    };
    const card = openingStopCard(focus, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'a6']);
    expect(card.sentences).toEqual([
      'Book until move 3 (Bc4).',
      'The book line ends here; Black continued with 3... a6.',
    ]);
    expect(card.preview).toBeUndefined();
  });

  it('whole game in book', () => {
    const focus: OpeningFocus = {
      openingName: 'Italian Game',
      eco: 'C50',
      lastBookPly: 5,
      leftBy: null,
    };
    const card = openingStopCard(focus, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    expect(card.sentences).toEqual(['Book until move 3 (Bc4).', 'The whole game stayed in book.']);
  });

  it('no family text: automatic sentences only, no placeholder', () => {
    const card = openingStopCard(
      { openingName: 'Amar Opening', eco: 'A00', lastBookPly: 1, leftBy: null },
      ['Nh3'],
    );
    expect(card.familyText).toBeUndefined();
    expect(card.sentences).toEqual(['Book until move 1 (Nh3).', 'The whole game stayed in book.']);
  });

  it('the first move already left the book', () => {
    const card = openingStopCard(
      { lastBookPly: 0, leftBy: 'white', leavePly: 1, endOfBook: true },
      ['a4'],
    );
    expect(card.sentences).toEqual(['The book line ends here; White continued with 1. a4.']);
  });
});
