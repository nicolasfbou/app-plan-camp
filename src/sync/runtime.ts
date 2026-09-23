/**
 * Démarrage de la synchronisation d'un espace d'organisation :
 * - un seul onglet exécute le moteur (verrou Web Locks), les autres affichent son état ;
 * - cycles : au démarrage, toutes les 20 s, au retour du réseau, après chaque écriture locale
 *   (petit délai de regroupement), quand l'onglet redevient visible.
 */
import { namespace, type Profile } from '@/app/profile.ts';
import { logEvent } from '@/diagnostics/errorLog.ts';
import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import { openPlanIds } from '@/persistence/planLock.ts';
import { api } from './api.ts';
import { onSync, postSync } from './bus.ts';
import { SyncEngine } from './engine.ts';
import { refreshSyncStore, useSyncStore } from './syncStore.ts';

let engine: SyncEngine | null = null;
let stopCurrent: (() => void) | null = null;

/** Arrête la synchronisation de cet onglet (avant la purge d'un espace). */
export function stopSync() {
  stopCurrent?.();
  stopCurrent = null;
}

/** Moteur de CET onglet (null si un autre onglet l'exécute). */
export const localEngine = () => engine;

export function startSync(profile: Profile): () => void {
  const raw = new IndexedDbRepository(profile.dbName);
  const store = useSyncStore.getState();
  store.set({ enabled: true });
  let stopped = false;
  const refresh = () => void refreshSyncStore(raw).catch(() => undefined);
  refresh();
  const poll = setInterval(refresh, 2000);
  const offMessages = onSync((m) => {
    if (m.type === 'status' && m.status) useSyncStore.getState().set({ engine: m.status });
    // Écriture locale mise en file (« kick ») : l'indicateur passe tout de suite à « Changements locaux ».
    if (m.type === 'server-updated' || m.type === 'pull-applied' || m.type === 'kick') refresh();
  });
  const onOnline = () => useSyncStore.getState().set({ online: navigator.onLine });
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOnline);

  let release: () => void = () => undefined;
  const lead = () => {
    engine = new SyncEngine({ raw, api, orgId: profile.orgId!, openPlanIds, post: postSync });
    const e = engine;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      if (stopped) return;
      void e.runOnce().finally(refresh);
    };
    const soon = (ms = 800) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, ms);
    };
    const offKick = onSync((m) => {
      if (m.type === 'kick' && m.force) void e.resetBackoff().then(() => soon(100));
      else if (m.type === 'kick') soon();
      if (m.type === 'apply-pull' && m.planId)
        void e
          .applyDeferredPulls(m.planId)
          .catch((error: unknown) => logEvent('storage', error, { context: `synchro ${m.planId}` }))
          .finally(refresh);
    });
    const interval = setInterval(run, 20_000);
    const onVisible = () => document.visibilityState === 'visible' && soon(200);
    const onBack = () => void e.resetBackoff().then(() => soon(200));
    window.addEventListener('online', onBack);
    document.addEventListener('visibilitychange', onVisible);
    run();
    return () => {
      offKick();
      clearInterval(interval);
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', onBack);
      document.removeEventListener('visibilitychange', onVisible);
      engine = null;
    };
  };
  if (navigator.locks)
    void navigator.locks.request(`campplanner-sync-${namespace(profile)}`, async () => {
      if (stopped) return;
      const off = lead();
      await new Promise<void>((resolve) => (release = resolve));
      off();
    });
  else release = lead();

  const stop = () => {
    stopped = true;
    release();
    clearInterval(poll);
    offMessages();
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOnline);
    raw.shutdown();
  };
  stopCurrent = stop;
  return stop;
}
