import { describe, expect, it, vi } from 'vitest';
import { parseRoomHash } from '../room/route';
import { MAX_SERVER_TOKEN_LENGTH } from '../store/settingsStore';
import {
  consumeSetupLink,
  isSetupHash,
  parseSetupHash,
  SETUP_SAVED_NOTICE,
  setupLink,
} from './setupLink';

function deps(hash: string, pathname = '/', search = '') {
  const replaceState = vi.fn();
  const setToken = vi.fn();
  const notify = vi.fn();
  return {
    replaceState,
    setToken,
    notify,
    d: {
      location: { hash, pathname, search },
      history: { replaceState, state: { s: 1 } },
      setToken,
      notify,
    },
  };
}

describe('setup link', () => {
  it('builds the link with an encoded token and parses it back', () => {
    const link = setupLink('a b/c#d', { origin: 'https://x.example', pathname: '/' });
    expect(link).toBe('https://x.example/#setup-token=a%20b%2Fc%23d');
    expect(parseSetupHash(link.slice(link.indexOf('#')))).toBe('a b/c#d');
  });

  it('parseSetupHash: valid, trimmed, empty, too long, malformed, other hashes', () => {
    expect(parseSetupHash('#setup-token=test-token-123')).toBe('test-token-123');
    expect(parseSetupHash('#setup-token=%20abc%20')).toBe('abc');
    expect(parseSetupHash('#setup-token=')).toBeNull();
    expect(parseSetupHash('#setup-token=%20%20')).toBeNull();
    expect(parseSetupHash(`#setup-token=${'a'.repeat(MAX_SERVER_TOKEN_LENGTH)}`)).toHaveLength(
      MAX_SERVER_TOKEN_LENGTH,
    );
    expect(parseSetupHash(`#setup-token=${'a'.repeat(MAX_SERVER_TOKEN_LENGTH + 1)}`)).toBeNull();
    expect(parseSetupHash('#setup-token=%E0%A4%A')).toBeNull();
    expect(parseSetupHash('')).toBeNull();
    expect(parseSetupHash('#/room/abc')).toBeNull();
  });

  it('does not collide with the room route', () => {
    expect(isSetupHash('#/room/abcdefgh')).toBe(false);
    expect(parseRoomHash('#setup-token=abc')).toBeNull();
  });

  it('consume: stores the token, removes the fragment (keeps path and query), notifies', () => {
    const t = deps('#setup-token=test-token-123', '/app/', '?x=1');
    expect(consumeSetupLink(t.d)).toBe(true);
    expect(t.setToken).toHaveBeenCalledWith('test-token-123');
    expect(t.replaceState).toHaveBeenCalledWith({ s: 1 }, '', '/app/?x=1');
    expect(t.notify).toHaveBeenCalledWith(SETUP_SAVED_NOTICE);
  });

  it('consume: an invalid token is not stored but the fragment is still removed', () => {
    for (const hash of ['#setup-token=', `#setup-token=${'x'.repeat(300)}`]) {
      const t = deps(hash);
      expect(consumeSetupLink(t.d)).toBe(false);
      expect(t.setToken).not.toHaveBeenCalled();
      expect(t.notify).not.toHaveBeenCalled();
      expect(t.replaceState).toHaveBeenCalledWith({ s: 1 }, '', '/');
    }
  });

  it('consume: leaves room routes and empty hashes alone', () => {
    for (const hash of ['#/room/abcdefgh', '']) {
      const t = deps(hash);
      expect(consumeSetupLink(t.d)).toBe(false);
      expect(t.replaceState).not.toHaveBeenCalled();
      expect(t.setToken).not.toHaveBeenCalled();
    }
  });
});
