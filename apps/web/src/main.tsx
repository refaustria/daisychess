import './zodConfig';
import './storage/runMigration';
import { takeMigrationNotice } from './migrate/runMigrateLink';
import './setup/runSetupLink';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './engine/devHook';
import { useLichessAuth } from './lichess/auth';
import { startAnalysisController } from './store/analysisStore';
import { applySettings } from './store/settingsStore';
import { useUiStore } from './store/uiStore';

applySettings();
// Moved from c.referee.at (ADR-021): show the one-time notice, next to a setup-link notice if any.
const movedNotice = takeMigrationNotice();
if (movedNotice) {
  const ui = useUiStore.getState();
  ui.showNotice(ui.notice ? `${movedNotice}. ${ui.notice}` : movedNotice);
}
startAnalysisController();
// Returning from the lichess login (?code=&state=): exchange the code, then clean the URL.
void useLichessAuth.getState().handleCallback();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
