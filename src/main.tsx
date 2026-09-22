import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { repository } from './app/repository.ts';
import './index.css';

// Demande au navigateur de ne pas purger les données locales en cas de manque d'espace.
void navigator.storage?.persist?.().catch(() => undefined);
// Nettoie les fichiers devenus orphelins (ex. import annulé avant la dernière fermeture).
void repository.deleteOrphanBlobs().catch(() => undefined);

const root = document.getElementById('root');
if (!root) throw new Error('Élément #root introuvable.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
