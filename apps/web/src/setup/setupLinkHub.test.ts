import { describe, expect, it, vi } from 'vitest';
import {
  SETUP_HUB_SAVED_NOTICE,
  SETUP_SAVED_NOTICE,
  consumeSetupLink,
  parseSetupHash,
  parseSetupPayload,
  schemeSetupToHash,
} from './setupLink';

const HUB = 'wss://hub.example/ws';

describe('setup link with hub', () => {
  it('parses token and hub', () => {
    const hash = `#setup-token=dc1_AB&hub=${encodeURIComponent(HUB)}`;
    expect(parseSetupPayload(hash)).toEqual({ token: 'dc1_AB', hub: HUB });
    expect(parseSetupHash(hash)).toBe('dc1_AB');
  });

  it('accepts an unencoded hub and a plain link without hub', () => {
    expect(parseSetupPayload(`#setup-token=t&hub=${HUB}`)).toEqual({ token: 't', hub: HUB });
    expect(parseSetupPayload('#setup-token=t')).toEqual({ token: 't' });
  });

  it('rejects the whole link for an invalid hub (like settings.remoteUrl)', () => {
    for (const bad of [
      'https://hub.example',
      'ws://',
      'wss://a b',
      '',
      `wss://${'x'.repeat(201)}`,
      '%E0%A4%A',
    ])
      expect(parseSetupPayload(`#setup-token=t&hub=${bad}`)).toBeNull();
  });

  it('keeps rejecting empty tokens', () => {
    expect(parseSetupPayload(`#setup-token=&hub=${HUB}`)).toBeNull();
  });

  it('converts daisychess://setup URLs to the fragment form', () => {
    const url = `daisychess://setup?token=dc1_A%20B&hub=${encodeURIComponent(HUB)}`;
    expect(schemeSetupToHash(url)).toBe(`#setup-token=dc1_A%20B&hub=${encodeURIComponent(HUB)}`);
    expect(schemeSetupToHash('daisychess://setup?token=t')).toBe('#setup-token=t');
    expect(schemeSetupToHash('daisychess://setup/?token=t')).toBe('#setup-token=t');
    expect(schemeSetupToHash('daisychess://setup')).toBeNull();
    expect(schemeSetupToHash('daisychess://lichess-callback?token=t')).toBeNull();
  });

  it('stores the hub through setHub and shows the matching notice', () => {
    const deps = {
      location: {
        hash: `#setup-token=t&hub=${encodeURIComponent(HUB)}`,
        pathname: '/',
        search: '',
      },
      history: { state: null, replaceState: vi.fn() },
      setToken: vi.fn(),
      setHub: vi.fn(),
      notify: vi.fn(),
    };
    expect(consumeSetupLink(deps)).toBe(true);
    expect(deps.setToken).toHaveBeenCalledWith('t');
    expect(deps.setHub).toHaveBeenCalledWith(HUB);
    expect(deps.notify).toHaveBeenCalledWith(SETUP_HUB_SAVED_NOTICE);
  });

  it('stores nothing for an invalid hub and leaves no token behind', () => {
    const deps = {
      location: { hash: '#setup-token=t&hub=https://evil.example', pathname: '/', search: '' },
      history: { state: null, replaceState: vi.fn() },
      setToken: vi.fn(),
      setHub: vi.fn(),
      notify: vi.fn(),
    };
    expect(consumeSetupLink(deps)).toBe(false);
    expect(deps.setToken).not.toHaveBeenCalled();
    expect(deps.setHub).not.toHaveBeenCalled();
    expect(deps.history.replaceState).toHaveBeenCalled();
  });

  it('plain links keep the original notice and never touch the hub', () => {
    const deps = {
      location: { hash: '#setup-token=t', pathname: '/', search: '' },
      history: { state: null, replaceState: vi.fn() },
      setToken: vi.fn(),
      setHub: vi.fn(),
      notify: vi.fn(),
    };
    expect(consumeSetupLink(deps)).toBe(true);
    expect(deps.setHub).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith(SETUP_SAVED_NOTICE);
  });
});
