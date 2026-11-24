import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { API_BASE_URL } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import { GuildProvider } from './auth/GuildContext';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URL(API_BASE_URL, window.location.origin).hostname.split('.')[0] === 'jedi-party-scheduler-worker-sandbox' && (
      <aside className="bg-amber-300 py-1 text-center font-bold tracking-wide text-black">SANDBOX</aside>
    )}
    <HashRouter>
      <AuthProvider>
        <GuildProvider>
          <App />
        </GuildProvider>
      </AuthProvider>
    </HashRouter>
  </React.StrictMode>,
);
