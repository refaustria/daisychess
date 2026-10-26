import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLichessAuth } from '../lichess/auth';
import {
  gameUrl,
  IMPORT_ONLINE_KEY,
  importUsernames,
  knownNames,
  MAX_MY_NAMES,
  MAX_NAME_LENGTH,
  MY_NAMES_KEY,
  parseNames,
  readMyNames,
  resolveUserSide,
  sideFromNames,
  writeMyNames,
} from './userSide';

const H = { White: 'Alice', Black: 'BobTheBuilder', Site: 'https://lichess.org/abcdefgh' };

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  useLichessAuth.setState({ username: undefined });
});

describe('resolveUserSide', () => {
  it('takes the engine game colour first, then the room, then the live game', () => {
    expect(resolveUserSide(H, { play: 'black', room: 'white', live: 'white' }, ['alice'])).toEqual({
      source: 'play',
      userSide: 'black',
    });
    expect(resolveUserSide(H, { room: 'black', live: 'white' }, ['alice'])).toEqual({
      source: 'room',
      userSide: 'black',
    });
    expect(resolveUserSide(H, { live: 'white' }, ['bobthebuilder'])).toEqual({
      source: 'live',
      userSide: 'white',
    });
  });

  it('matches the White/Black headers case-insensitively for imports and PGNs', () => {
    expect(resolveUserSide(H, {}, ['  BOBTHEBUILDER '])).toEqual({
      source: 'import',
      userSide: 'black',
    });
    expect(resolveUserSide({ ...H, Site: 'Vienna AUT' }, {}, ['alice'])).toEqual({
      source: 'pgn',
      userSide: 'white',
    });
  });

  it('leaves the side unknown without a match', () => {
    expect(resolveUserSide(H, {}, ['carol'])).toEqual({ source: 'import' });
    expect(resolveUserSide({}, {}, [])).toEqual({ source: 'pgn' });
  });

  it('classifies chess.com games by their Link header as imports', () => {
    const cc = {
      White: 'a',
      Black: 'b',
      Site: 'Chess.com',
      Link: 'https://www.chess.com/game/live/1',
    };
    expect(resolveUserSide(cc, {}, []).source).toBe('import');
  });
});

describe('sideFromNames', () => {
  it('gives nothing when both sides match (a game against oneself)', () => {
    expect(sideFromNames({ White: 'me', Black: 'ME' }, ['me'])).toBeUndefined();
  });

  it('ignores PGN placeholders on both sides', () => {
    expect(sideFromNames({ White: '?', Black: 'x' }, ['?'])).toBeUndefined();
    expect(sideFromNames({ White: '?', Black: 'x' }, ['x'])).toBe('black');
  });
});

describe('gameUrl', () => {
  it('prefers Link, accepts an http(s) Site and nothing else', () => {
    expect(gameUrl({ Link: 'https://www.chess.com/game/1', Site: 'https://x.org' })).toBe(
      'https://www.chess.com/game/1',
    );
    expect(gameUrl({ Site: 'https://lichess.org/abc' })).toBe('https://lichess.org/abc');
    expect(gameUrl({ Site: 'Vienna', Link: 'javascript:alert(1)' })).toBeUndefined();
  });
});

describe('My names', () => {
  it('parses commas, semicolons and line breaks, trims, dedupes and caps', () => {
    expect(parseNames(' Alice , alice;Bob\n\n?, carol ')).toEqual(['Alice', 'Bob', 'carol']);
    const many = Array.from({ length: 30 }, (_, i) => `n${i}`).join(',');
    expect(parseNames(many)).toHaveLength(MAX_MY_NAMES);
    expect(parseNames('x'.repeat(80))[0]).toHaveLength(MAX_NAME_LENGTH);
  });

  it('round-trips through localStorage and removes the key when empty', () => {
    expect(writeMyNames(['Alice', 'ALICE', 'Bob'])).toEqual(['Alice', 'Bob']);
    expect(readMyNames()).toEqual(['Alice', 'Bob']);
    writeMyNames([]);
    expect(localStorage.getItem(MY_NAMES_KEY)).toBeNull();
  });

  it('reads malformed storage as empty', () => {
    for (const raw of ['{', '"x"', '{"a":1}', 'null', '[1, null, {}]']) {
      localStorage.setItem(MY_NAMES_KEY, raw);
      expect(readMyNames()).toEqual([]);
    }
    localStorage.setItem(MY_NAMES_KEY, '[1, "ok", null]');
    expect(readMyNames()).toEqual(['ok']);
  });
});

describe('knownNames', () => {
  it('combines the lichess login, the import usernames and My names without duplicates', () => {
    useLichessAuth.setState({ username: 'LoginName' });
    localStorage.setItem(
      IMPORT_ONLINE_KEY,
      JSON.stringify({ site: 'lichess', users: { lichess: 'loginname', chesscom: 'cc_me', x: 3 } }),
    );
    writeMyNames(['Club Name']);
    expect(knownNames()).toEqual(['LoginName', 'cc_me', 'Club Name']);
  });

  it('copes with a corrupt import entry', () => {
    localStorage.setItem(IMPORT_ONLINE_KEY, '{"users": 5}');
    expect(importUsernames()).toEqual([]);
    localStorage.setItem(IMPORT_ONLINE_KEY, 'not json');
    expect(knownNames()).toEqual([]);
  });
});
