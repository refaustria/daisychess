import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMobileBuild, isNativeApp, nativePlatform } from './index';

function bridge(platform: string, native = true) {
  vi.stubGlobal('Capacitor', { isNativePlatform: () => native, getPlatform: () => platform });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('platform seam on the web build', () => {
  it('is a no-op without the bridge', () => {
    expect(isMobileBuild()).toBe(false);
    expect(isNativeApp()).toBe(false);
    expect(nativePlatform()).toBeNull();
  });

  it('ignores a Capacitor global outside the mobile build (a page cannot pretend to be the app)', () => {
    bridge('android');
    expect(isNativeApp()).toBe(false);
    expect(nativePlatform()).toBeNull();
  });
});

describe('platform seam in the mobile build', () => {
  it('detects the native shell and its platform', () => {
    vi.stubEnv('MODE', 'mobile');
    expect(isMobileBuild()).toBe(true);
    bridge('ios');
    expect(isNativeApp()).toBe(true);
    expect(nativePlatform()).toBe('ios');
    bridge('android');
    expect(nativePlatform()).toBe('android');
  });

  it('is false in a browser (mobile bundle opened as a page, or bridge says web)', () => {
    vi.stubEnv('MODE', 'mobile');
    expect(isNativeApp()).toBe(false);
    bridge('web', false);
    expect(isNativeApp()).toBe(false);
    expect(nativePlatform()).toBeNull();
  });

  it('returns null for an unknown native platform and survives a throwing bridge', () => {
    vi.stubEnv('MODE', 'mobile');
    bridge('electron');
    expect(isNativeApp()).toBe(true);
    expect(nativePlatform()).toBeNull();
    vi.stubGlobal('Capacitor', {
      isNativePlatform: () => {
        throw new Error('boom');
      },
    });
    expect(isNativeApp()).toBe(false);
  });
});
