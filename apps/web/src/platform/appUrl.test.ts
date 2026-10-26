import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appLinkHash,
  dispatchAppUrl,
  handleOpenedUrl,
  installAppUrlRouting,
  registerAppUrlHandler,
  registerBuiltinAppUrlHandlers,
  resetAppUrl,
  roomHashOfUrl,
  setupHashOfUrl,
} from './appUrl';

afterEach(resetAppUrl);

describe('registerAppUrlHandler / dispatchAppUrl', () => {
  it('matches string prefixes case-insensitively and matcher functions', () => {
    const cb = vi.fn();
    const fn = vi.fn();
    registerAppUrlHandler('org.daisychess.app://lichess-callback', cb);
    registerAppUrlHandler((u) => u.endsWith('!'), fn);
    expect(dispatchAppUrl('Org.DaisyChess.App://lichess-callback?code=1')).toBe(1);
    expect(cb).toHaveBeenCalledWith('Org.DaisyChess.App://lichess-callback?code=1');
    expect(dispatchAppUrl('x!')).toBe(1);
    expect(dispatchAppUrl('daisychess://other')).toBe(0);
  });

  it('runs every matching handler, survives throwing handlers and can unregister', () => {
    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    registerAppUrlHandler('x:', a);
    const off = registerAppUrlHandler('x:', b);
    expect(dispatchAppUrl('x:1')).toBe(2);
    expect(b).toHaveBeenCalledTimes(1);
    off();
    expect(dispatchAppUrl('x:1')).toBe(1);
  });

  it('a throwing matcher does not match', () => {
    registerAppUrlHandler(() => {
      throw new Error('x');
    }, vi.fn());
    expect(dispatchAppUrl('x')).toBe(0);
  });
});

describe('url classification', () => {
  it('extracts the fragment only for the claimed origin', () => {
    expect(appLinkHash('https://play.daisychess.org/#/room/abc')).toBe('#/room/abc');
    expect(appLinkHash('https://play.daisychess.org/')).toBe('');
    expect(appLinkHash('https://play.daisychess.org.evil.example/#x')).toBeNull();
    expect(appLinkHash('https://evil.example/#x')).toBeNull();
    expect(appLinkHash('http://play.daisychess.org/#x')).toBeNull();
  });

  it('recognises setup and room links', () => {
    expect(setupHashOfUrl('https://play.daisychess.org/#setup-token=t')).toBe('#setup-token=t');
    expect(setupHashOfUrl('daisychess://setup?token=t&hub=wss%3A%2F%2Fh.example%2Fws')).toBe(
      '#setup-token=t&hub=wss%3A%2F%2Fh.example%2Fws',
    );
    expect(setupHashOfUrl('https://evil.example/#setup-token=t')).toBeNull();
    expect(roomHashOfUrl('https://play.daisychess.org/#/room/abcdefgh12345678')).toBe(
      '#/room/abcdefgh12345678',
    );
    expect(roomHashOfUrl('https://play.daisychess.org/#/room/short')).toBeNull();
    expect(roomHashOfUrl('https://evil.example/#/room/abc')).toBeNull();
  });
});

describe('built-in routes', () => {
  it('routes setup links and valid room links, leaves lichess-callback alone', () => {
    const routes = { setup: vi.fn(), room: vi.fn() };
    registerBuiltinAppUrlHandlers(routes);
    const lichess = vi.fn();
    registerAppUrlHandler('org.daisychess.app://lichess-callback', lichess);

    expect(dispatchAppUrl('https://play.daisychess.org/#setup-token=t')).toBe(1);
    expect(routes.setup).toHaveBeenCalledWith('#setup-token=t');
    expect(dispatchAppUrl('daisychess://setup?token=t')).toBe(1);
    expect(routes.setup).toHaveBeenLastCalledWith('#setup-token=t');

    const roomUrl = 'https://play.daisychess.org/#/room/abcdefgh12345678_-X';
    expect(dispatchAppUrl(roomUrl)).toBe(1);
    expect(routes.room).toHaveBeenCalledWith('#/room/abcdefgh12345678_-X');

    expect(dispatchAppUrl('org.daisychess.app://lichess-callback?code=c&state=s')).toBe(1);
    expect(lichess).toHaveBeenCalledTimes(1);
    expect(routes.setup).toHaveBeenCalledTimes(2);
  });

  it('ignores unknown URLs', () => {
    registerBuiltinAppUrlHandlers({ setup: vi.fn(), room: vi.fn() });
    expect(dispatchAppUrl('https://play.daisychess.org/portal/')).toBe(0);
    expect(dispatchAppUrl('https://example.com/#setup-token=t')).toBe(0);
  });
});

describe('handleOpenedUrl', () => {
  it('drops an immediate repeat but not a later one', () => {
    const fn = vi.fn();
    registerAppUrlHandler('x:', fn);
    expect(handleOpenedUrl('x:1', 1000)).toBe(1);
    expect(handleOpenedUrl('x:1', 1500)).toBe(0);
    expect(handleOpenedUrl('x:2', 1600)).toBe(1);
    expect(handleOpenedUrl('x:2', 4000)).toBe(1);
  });
});

describe('installAppUrlRouting', () => {
  it('is a no-op outside the native app', async () => {
    await expect(installAppUrlRouting()).resolves.toBeUndefined();
  });
});
