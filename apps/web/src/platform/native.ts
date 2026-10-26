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
