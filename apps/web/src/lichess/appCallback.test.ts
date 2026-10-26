import { afterEach, describe, expect, it, vi } from 'vitest';

const handled = vi.fn<(url: string) => Promise<boolean>>(async () => true);
vi.mock('./auth', async (orig) => ({
  ...(await orig<typeof import('./auth')>()),
  handleLichessCallback: (url: string) => handled(url),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  handled.mockClear();
});

describe('appCallback (M26-2)', () => {
  it('routes the lichess callback URL from the app URL dispatcher in the mobile build', async () => {
    vi.stubEnv('MODE', 'mobile');
    const { dispatchAppUrl } = await import('../platform/appUrl');
    await import('./appCallback');
    const url = 'org.daisychess.app://lichess-callback?code=c&state=s';
    expect(dispatchAppUrl(url)).toBe(1);
    expect(handled).toHaveBeenCalledWith(url);
    expect(dispatchAppUrl('daisychess://lichess-callback?code=c&state=s')).toBe(0);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it('registers nothing in the web build', async () => {
    const { dispatchAppUrl } = await import('../platform/appUrl');
    await import('./appCallback');
    expect(dispatchAppUrl('org.daisychess.app://lichess-callback?code=c&state=s')).toBe(0);
    expect(handled).not.toHaveBeenCalled();
  });
});
