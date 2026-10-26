/**
 * Lazy loaders of the Capacitor plugins used by the native polish (M26-4). Every loader starts
 * with the literal build-mode check, so `vite build` (mode `production`) folds the dynamic
 * imports away and the web bundle has no trace of any plugin (same pattern as `appUrl.ts`).
 * The logic around the plugins lives in the sibling modules and takes these ports as arguments,
 * so it is unit-tested with fakes.
 */
import { isNativeApp } from './index';

export interface HapticsPort {
  impact(kind: 'light' | 'medium' | 'heavy'): Promise<void>;
  notify(kind: 'success' | 'warning' | 'error'): Promise<void>;
}

export interface KeepAwakePort {
  keepAwake(): Promise<void>;
  allowSleep(): Promise<void>;
}

export interface StatusBarPort {
  /** `dark` theme = light status-bar text. */
  setTheme(theme: 'light' | 'dark'): Promise<void>;
}

export interface PreferencesPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface AppStatePort {
  onStateChange(fn: (isActive: boolean) => void): Promise<void>;
  onBackButton(fn: () => void): Promise<void>;
  exitApp(): Promise<void>;
}

export interface FilesPort {
  /** File size in bytes, or null when the platform cannot tell (content:// URIs). */
  size(uri: string): Promise<number | null>;
  /** The raw bytes of a `file://` or `content://` URI. */
  read(uri: string): Promise<Uint8Array>;
  /** Best-effort delete of an app-private copy (the iOS Inbox). */
  remove(uri: string): Promise<void>;
}

export interface SharePort {
  share(content: { title?: string; text?: string; url?: string }): Promise<void>;
}

/** True in the app: the only place the loaders below return anything. */
function active(): boolean {
  return isNativeApp();
}

export async function loadHaptics(): Promise<HapticsPort | null> {
  if (import.meta.env.MODE !== 'mobile' || !active()) return null;
  const { Haptics, ImpactStyle, NotificationType } = await import('@capacitor/haptics');
  const impact = { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy };
  const note = {
    success: NotificationType.Success,
    warning: NotificationType.Warning,
    error: NotificationType.Error,
  };
  return {
    impact: (k) => Haptics.impact({ style: impact[k] }),
    notify: (k) => Haptics.notification({ type: note[k] }),
  };
}

export async function loadKeepAwake(): Promise<KeepAwakePort | null> {
  if (import.meta.env.MODE !== 'mobile' || !active()) return null;
  const { KeepAwake } = await import('@capacitor-community/keep-awake');
  return { keepAwake: () => KeepAwake.keepAwake(), allowSleep: () => KeepAwake.allowSleep() };
}

export async function loadStatusBar(): Promise<StatusBarPort | null> {
  if (import.meta.env.MODE !== 'mobile' || !active()) return null;
  const { StatusBar, Style } = await import('@capacitor/status-bar');
  return {
    // Style.Dark = light text for dark backgrounds.
    setTheme: (t) => StatusBar.setStyle({ style: t === 'dark' ? Style.Dark : Style.Light }),
  };
}

export async function loadPreferences(): Promise<PreferencesPort | null> {
  if (import.meta.env.MODE !== 'mobile' || !active()) return null;
  const { Preferences } = await import('@capacitor/preferences');
  return {
    get: async (key) => (await Preferences.get({ key })).value,
    set: (key, value) => Preferences.set({ key, value }),
    remove: (key) => Preferences.remove({ key }),
  };
}

export async function loadAppState(): Promise<AppStatePort | null> {
  if (import.meta.env.MODE !== 'mobile' || !active()) return null;
  const { App } = await import('@capacitor/app');
  return {
    onStateChange: async (fn) => {
      await App.addListener('appStateChange', (e) => fn(e.isActive));
    },
    onBackButton: async (fn) => {
      await App.addListener('backButton', () => fn());
    },
    exitApp: () => App.exitApp(),
  };
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function loadFiles(): Promise<FilesPort | null> {
  if (import.meta.env.MODE !== 'mobile' || !active()) return null;
  const { Filesystem } = await import('@capacitor/filesystem');
  return {
    size: async (uri) => {
      try {
        return (await Filesystem.stat({ path: uri })).size;
      } catch {
        return null;
      }
    },
    read: async (uri) => {
      // No `encoding`: the plugin returns base64, so we decide on UTF-8 vs Latin-1 ourselves.
      const { data } = await Filesystem.readFile({ path: uri });
      if (typeof data !== 'string') return new Uint8Array(await data.arrayBuffer());
      return base64Bytes(data);
    },
    remove: (uri) => Filesystem.deleteFile({ path: uri }),
  };
}

export async function loadShare(): Promise<SharePort | null> {
  if (import.meta.env.MODE !== 'mobile' || !active()) return null;
  const { Share } = await import('@capacitor/share');
  return {
    share: async (c) => {
      await Share.share({ ...c, dialogTitle: c.title });
    },
  };
}
