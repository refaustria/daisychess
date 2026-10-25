// Side-effect module: imported right after the storage migration in main.tsx (before the stores
// are used), consumes a `#setup-token=` fragment once.
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { consumeSetupLink } from './setupLink';

try {
  consumeSetupLink({
    location: globalThis.location,
    history: globalThis.history,
    setToken: (t) => useSettingsStore.getState().setServerToken(t),
    notify: (t) => useUiStore.getState().showNotice(t),
  });
} catch {
  /* no location/history (non-browser): nothing to do */
}
