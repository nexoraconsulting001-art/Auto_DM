import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/unbounded/wght.css';
import '@fontsource-variable/figtree/wght.css';
import './design/tokens.css';
import './design/base.css';
import './design/components.css';
import { App } from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
