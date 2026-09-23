import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { repository } from './app/repository.ts';
import { startBackupScheduler } from './backups/backupService.ts';
import { installGlobalErrorLogging, logEvent } from './diagnostics/errorLog.ts';
import { recoveryJournalTexts } from './persistence/recovery.ts';
import './index.css';

// Demande au navigateur de ne pas purger les données locales en cas de manque d'espace.
void navigator.storage?.persist?.().catch(() => undefined);
installGlobalErrorLogging();
// Sauvegardes externes automatiques (un seul onglet planifie).
void startBackupScheduler().catch((error: unknown) => logEvent('backup', error));
// Nettoie les fichiers devenus orphelins (ex. import annulé avant la dernière fermeture) — sauf si
// un plan est ouvert dans un autre onglet (il peut référencer un fichier pas encore enregistré).
void (async () => {
  const held = (await navigator.locks?.query?.())?.held ?? [];
  if (held.some((l) => l.name?.startsWith('campplanner-plan-'))) return;
  await repository.deleteOrphanBlobs(undefined, recoveryJournalTexts());
})().catch(() => undefined);

const root = document.getElementById('root');
if (!root) throw new Error('Élément #root introuvable.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
