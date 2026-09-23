/**
 * Ouverture d'un plan : verrou d'édition local (un seul onglet modifie le plan, les autres le
 * lisent), chargement validé avec sa version, sauvegarde automatique à version contrôlée (conflit
 * affiché plutôt qu'écrasement), écriture forcée quand l'onglet est masqué ou fermé, journal de
 * récupération relu après une fermeture brutale.
 */
import { useEffect, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { logEvent } from '@/diagnostics/errorLog.ts';
import { t } from '@/i18n/index.ts';
import { startAutosave } from '@/persistence/autosave.ts';
import { acquirePlanLock, type LockMode } from '@/persistence/planLock.ts';
import { PlanConflictError } from '@/persistence/ProjectRepository.ts';
import {
  clearRecovery,
  clearRecoveryIfCovered,
  readRecovery,
  writeRecovery,
} from '@/persistence/recovery.ts';
import { planStore, selectIsDirty } from '@/store/planStore.ts';
import { persistOpenPlan, useSessionStore } from './sessionStore.ts';

export type SessionState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

/** Relit le plan enregistré (version comprise) et remplace le document ouvert. */
export async function reloadOpenPlan(planId: string): Promise<void> {
  const opened = await repository.openPlan(planId);
  if (!opened) throw new Error(t('plans.notFound'));
  const readOnly = planStore.getState().readOnly;
  planStore.getState().load(opened.doc);
  planStore.getState().setReadOnly(readOnly);
  useSessionStore.getState().setVersion(opened.version);
  useSessionStore.getState().setConflict(null);
}

export function usePlanSession(planId: string) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    // Le composant appelant est remonté pour chaque plan : l'état initial est déjà « loading ».
    let cancelled = false;
    const lock = acquirePlanLock(planId);
    const session = useSessionStore.getState();
    session.begin(planId, lock);

    const firstMode = new Promise<LockMode>((resolve) => {
      if (lock.mode !== 'pending') return resolve(lock.mode);
      const off = lock.subscribe((mode) => {
        off();
        resolve(mode);
      });
      // Verrou indisponible (API absente ou bloquée) : on ouvre, les conflits restent détectés.
      setTimeout(() => resolve(lock.mode === 'pending' ? 'unsupported' : lock.mode), 2000);
    });

    let loaded = false;
    lock.subscribe((mode) => {
      useSessionStore.getState().setLockMode(mode);
      planStore.getState().setReadOnly(mode === 'readonly');
      if (mode === 'readonly')
        logEvent('lock', 'Plan ouvert ailleurs : lecture seule.', {
          level: 'info',
          context: `plan ${planId}`,
        });
      // Prise de la main après une lecture seule : on repart du plan tel qu'enregistré ailleurs.
      if (mode === 'editor' && loaded)
        void reloadOpenPlan(planId).catch((error: unknown) =>
          logEvent('lock', error, { context: `plan ${planId}` }),
        );
    });

    (async () => {
      const mode = await firstMode;
      useSessionStore.getState().setLockMode(mode);
      const editing = mode !== 'readonly';
      // Journal de récupération (fermeture brutale) : seulement par l'onglet qui édite, et s'il est
      // plus récent que la dernière sauvegarde IndexedDB.
      if (editing) {
        const recovered = readRecovery(planId);
        if (recovered) {
          const savedAt = await repository.getPlanSavedAt(planId);
          if (savedAt === undefined || recovered.writtenAt > savedAt) {
            await repository.savePlan(recovered.doc);
            logEvent('recovery', 'Modifications récupérées après une fermeture brutale.', {
              level: 'info',
              context: `plan ${planId}`,
            });
          }
          clearRecovery(planId);
        }
      }
      return { opened: await repository.openPlan(planId), editing };
    })().then(
      ({ opened, editing }) => {
        if (cancelled) return;
        if (!opened) return setState({ status: 'error', message: t('plans.notFound') });
        planStore.getState().load(opened.doc);
        planStore.getState().setReadOnly(!editing);
        useSessionStore.getState().setVersion(opened.version);
        loaded = true;
        setState({ status: 'ready' });
      },
      (error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        logEvent(/migration|format/i.test(message) ? 'migration' : 'corrupt', error, {
          context: `plan ${planId}`,
        });
        setState({ status: 'error', message: t('plans.loadError', { message }) });
      },
    );

    const autosave = startAutosave({
      store: planStore,
      save: async (doc) => {
        // Lecture seule ou conflit en cours : rien n'est écrit (le conflit attend une décision).
        if (planStore.getState().readOnly || useSessionStore.getState().conflict) return;
        const startedAt = Date.now();
        await persistOpenPlan(doc);
        clearRecoveryIfCovered(doc.plan.id, startedAt);
        setSaveError(null);
      },
      onError: (error) => {
        if (!(error instanceof PlanConflictError)) logEvent('storage', error, { context: `plan ${planId}` });
        setSaveError(error instanceof Error ? error.message : String(error));
      },
    });
    // Avant de céder la main à un autre onglet : écrire ce qui est en attente.
    lock.onBeforeRelease(() => autosave.flush());
    // Un autre onglet a enregistré : un lecteur se met à jour.
    lock.onRemoteSaved(() => {
      if (planStore.getState().readOnly && loaded)
        void reloadOpenPlan(planId).catch((error: unknown) =>
          logEvent('lock', error, { context: `plan ${planId}` }),
        );
    });

    // Fermeture de page : l'écriture IndexedDB est asynchrone et peut ne pas aboutir. On écrit
    // donc aussi, de façon synchrone, un journal de récupération relu à la prochaine ouverture.
    const journal = () => {
      const s = planStore.getState();
      if (s.doc?.plan.id === planId && !s.readOnly && selectIsDirty(s)) writeRecovery(s.doc);
    };
    const flush = () => {
      journal();
      void autosave.flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      flush();
      if (selectIsDirty(planStore.getState())) event.preventDefault();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', onBeforeUnload);
      // Écrit ce qui reste avant de quitter l'éditeur, puis ferme le plan et libère le verrou.
      void autosave.flush().finally(() => {
        autosave.dispose();
        lock.release();
        useSessionStore.getState().end(planId);
        if (planStore.getState().doc?.plan.id === planId) {
          planStore.getState().load(null);
          planStore.getState().setReadOnly(false);
        }
      });
    };
  }, [planId]);

  return { state, saveError };
}
