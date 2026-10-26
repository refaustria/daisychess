/**
 * Native key-value mirror (ADR-022, M26-4): iOS may purge the WebView's localStorage under storage
 * pressure, so the settings (with the server access token), the theme and the lichess login are
 * mirrored to `@capacitor/preferences` (UserDefaults / SharedPreferences). localStorage stays the
 * read-through cache every store reads synchronously; on start-up {@link restoreFromPreferences}
 * refills it from the mirror when a key is missing. No-op on the web.
 */
import { AUTH_STORAGE_KEY } from '../lichess/auth';
import { parseSettings, SETTINGS_KEY, useSettingsStore } from '../store/settingsStore';
import { loadPreferences, type PreferencesPort } from './native';

export const THEME_KEY = 'daisychess.theme';
export const MIRRORED_KEYS: readonly string[] = [SETTINGS_KEY, THEME_KEY, AUTH_STORAGE_KEY];

/** What the mirror needs from `localStorage` (and from fakes). */
export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Copies mirrored keys missing from `storage` out of the preferences, and backfills preferences
 * missing a key `storage` has (first run after the update). Returns the keys restored into storage.
 */
export async function restoreFromPreferences(
  storage: KvStorage,
  prefs: PreferencesPort,
  keys: readonly string[] = MIRRORED_KEYS,
): Promise<string[]> {
  const restored: string[] = [];
  for (const key of keys) {
    try {
      const local = storage.getItem(key);
      const mirrored = await prefs.get(key);
      if (local === null && mirrored !== null) {
        storage.setItem(key, mirrored);
        restored.push(key);
      } else if (local !== null && mirrored !== local) {
        await prefs.set(key, local);
      }
    } catch {
      /* one unreadable key must not block the others */
    }
  }
  return restored;
}

/**
 * Mirrors writes to the mirrored keys of `storage` into the preferences by wrapping
 * `proto.setItem` / `proto.removeItem` (the prototype: assigning methods on the Storage object
 * itself would store items). Returns the function that restores the originals.
 */
export function installStorageMirror(
  proto: Pick<Storage, 'setItem' | 'removeItem'>,
  storage: object,
  prefs: PreferencesPort,
  keys: readonly string[] = MIRRORED_KEYS,
): () => void {
  const origSet = proto.setItem;
  const origRemove = proto.removeItem;
  proto.setItem = function (this: Storage, key: string, value: string) {
    origSet.call(this, key, value);
    if (this === storage && keys.includes(key))
      void prefs.set(key, String(value)).catch(() => undefined);
  };
  proto.removeItem = function (this: Storage, key: string) {
    origRemove.call(this, key);
    if (this === storage && keys.includes(key)) void prefs.remove(key).catch(() => undefined);
  };
  return () => {
    proto.setItem = origSet;
    proto.removeItem = origRemove;
  };
}

/**
 * Native start-up step, awaited before the first render: restores purged keys, then lets the
 * stores that read them at import time pick up the restored values. Never throws.
 */
export async function setupNativeStorage(): Promise<void> {
  try {
    const prefs = await loadPreferences();
    if (!prefs) return;
    const restored = await restoreFromPreferences(localStorage, prefs);
    installStorageMirror(Storage.prototype, localStorage, prefs);
    if (restored.includes(SETTINGS_KEY)) {
      useSettingsStore.setState(parseSettings(localStorage.getItem(SETTINGS_KEY)));
    }
    if (restored.includes(THEME_KEY)) {
      const t = localStorage.getItem(THEME_KEY);
      if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    }
  } catch {
    /* the app runs on localStorage alone */
  }
}
