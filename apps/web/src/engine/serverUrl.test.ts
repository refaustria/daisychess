import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultServerUrl } from './serverUrl';

const APP_URL = 'wss://play.daisychess.org/ws';

function at(protocol: string, host: string) {
  vi.stubGlobal('location', { protocol, host });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('defaultServerUrl', () => {
  it('web build: same origin, wss on https and ws on http', () => {
    at('https:', 'play.daisychess.org');
    expect(defaultServerUrl()).toBe('wss://play.daisychess.org/ws');
    at('http:', 'localhost:5180');
    expect(defaultServerUrl()).toBe('ws://localhost:5180/ws');
  });

  it('web build: a non-http origin without the build constant keeps the old derivation', () => {
    at('capacitor:', 'app.daisychess.org');
    expect(defaultServerUrl()).toBe('ws://app.daisychess.org/ws');
  });

  it('mobile build on iOS (capacitor: origin) uses VITE_DEFAULT_SERVER_URL', () => {
    vi.stubEnv('MODE', 'mobile');
    vi.stubEnv('VITE_DEFAULT_SERVER_URL', APP_URL);
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'ios' });
    at('capacitor:', 'app.daisychess.org');
    expect(defaultServerUrl()).toBe(APP_URL);
  });

  it('mobile build on Android (https://app.daisychess.org) uses VITE_DEFAULT_SERVER_URL', () => {
    vi.stubEnv('MODE', 'mobile');
    vi.stubEnv('VITE_DEFAULT_SERVER_URL', APP_URL);
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
    at('https:', 'app.daisychess.org');
    expect(defaultServerUrl()).toBe(APP_URL);
  });

  it('mobile bundle served over http(s) outside the app stays same-origin (e.g. a preview)', () => {
    vi.stubEnv('MODE', 'mobile');
    vi.stubEnv('VITE_DEFAULT_SERVER_URL', APP_URL);
    at('http:', '127.0.0.1:4180');
    expect(defaultServerUrl()).toBe('ws://127.0.0.1:4180/ws');
  });
});
