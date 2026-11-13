import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../agora-kit/fonts';
import { ThemeProvider } from '../agora-kit/theme';
import { AGENT_ACCENT, App } from './App.js';
import './index.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root not found');
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider storageKey="agora-agent-theme" accent={AGENT_ACCENT}>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
