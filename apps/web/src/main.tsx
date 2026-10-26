import './zodConfig';
import './storage/runMigration';
import './setup/runSetupLink';
// Before the app URL routing starts: the lichess callback handler of the app (M26-2).
import './lichess/appCallback';
import './platform/installAppUrls';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './engine/devHook';
import { useLichessAuth } from './lichess/auth';
import { isNativeApp } from './platform';
import { installNative } from './platform/installNative';
import { setupNativeStorage } from './platform/nativeStorage';
import { installLedger } from './puzzles/installLedger';
import { startAnalysisController } from './store/analysisStore';
import { applySettings } from './store/settingsStore';

function start(): void {
  applySettings();
  startAnalysisController();
  // Stage-2 puzzles (ADR-023 §9): records every finished/loaded review in the game ledger.
  installLedger();
  // Returning from the lichess login (?code=&state=): exchange the code, then clean the URL.
  void useLichessAuth.getState().handleCallback();

  // CI-only native smoke check (ADR-022): compiled in only when VITE_MOBILE_SMOKE=1 at build time.
  if (import.meta.env.VITE_MOBILE_SMOKE === '1')
    void import('./platform/smoke').then((m) => m.runSmoke());

  const root = document.getElementById('root');
  if (!root) throw new Error('#root not found');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  installNative();
}

// In the app, settings/token purged from the WebView's localStorage come back from the native
// mirror before anything renders (M26-4); on the web this is a synchronous start.
if (import.meta.env.MODE === 'mobile' && isNativeApp()) void setupNativeStorage().finally(start);
else start();
