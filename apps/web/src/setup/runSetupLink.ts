// Side-effect module: imported right after the storage migration in main.tsx (before the stores
// are used), consumes a `#setup-token=` fragment once.
import { useSettingsStore } from '../store/settingsStore';
import { useAnalysisStore } from '../store/analysisStore';
import { useUiStore } from '../store/uiStore';
import { consumeSetupLink } from './setupLink';

/** Setup actions on the real stores (also used for links delivered by the app, see platform/appUrl). */
export const setupActions = {
  setToken: (t: string) => useSettingsStore.getState().setServerToken(t),
  setHub: (url: string) => useAnalysisStore.getState().setSettings({ remoteUrl: url }),
  notify: (t: string) => useUiStore.getState().showNotice(t),
};

try {
  consumeSetupLink({
    location: globalThis.location,
    history: globalThis.history,
    ...setupActions,
  });
} catch {
  /* no location/history (non-browser): nothing to do */
}
