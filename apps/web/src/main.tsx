import './zodConfig';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './engine/devHook';
import { useLichessAuth } from './lichess/auth';
import { startAnalysisController } from './store/analysisStore';
import { applySettings } from './store/settingsStore';

applySettings();
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
