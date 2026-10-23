import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './engine/devHook';
import { startAnalysisController } from './store/analysisStore';

startAnalysisController();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
