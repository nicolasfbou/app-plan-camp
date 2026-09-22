/**
 * Ouverture d'un plan : chargement validé, sauvegarde automatique branchée, écriture forcée
 * quand l'onglet est masqué ou fermé, et avertissement si des modifications sont en attente.
 */
import { useEffect, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { t } from '@/i18n/index.ts';
import { startAutosave } from '@/persistence/autosave.ts';
import {
  clearRecovery,
  clearRecoveryIfCovered,
  readRecovery,
  writeRecovery,
} from '@/persistence/recovery.ts';
import { planStore, selectIsDirty } from '@/store/planStore.ts';

export type SessionState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

export function usePlanSession(planId: string) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    // Le composant appelant est remonté pour chaque plan : l'état initial est déjà « loading ».
    let cancelled = false;
    (async () => {
      // Journal de récupération : modifications non encore écrites lors d'une fermeture brutale.
      // Appliqué seulement s'il est plus récent que la dernière sauvegarde IndexedDB.
      const recovered = readRecovery(planId);
      if (recovered) {
        const savedAt = await repository.getPlanSavedAt(planId);
        if (savedAt === undefined || recovered.writtenAt > savedAt) await repository.savePlan(recovered.doc);
        clearRecovery(planId);
      }
      return repository.loadPlan(planId);
    })().then(
      (doc) => {
        if (cancelled) return;
        if (!doc) return setState({ status: 'error', message: t('plans.notFound') });
        planStore.getState().load(doc);
        setState({ status: 'ready' });
      },
      (error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ status: 'error', message: t('plans.loadError', { message }) });
      },
    );

    const autosave = startAutosave({
      store: planStore,
      save: async (doc) => {
        const startedAt = Date.now();
        await repository.savePlan(doc);
        clearRecoveryIfCovered(doc.plan.id, startedAt);
        setSaveError(null);
      },
      onError: (error) => setSaveError(error instanceof Error ? error.message : String(error)),
    });
    // Fermeture de page : l'écriture IndexedDB est asynchrone et peut ne pas aboutir. On écrit
    // donc aussi, de façon synchrone, un journal de récupération relu à la prochaine ouverture.
    const journal = () => {
      const state = planStore.getState();
      if (state.doc?.plan.id === planId && selectIsDirty(state)) writeRecovery(state.doc);
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
      // Écrit ce qui reste avant de quitter l'éditeur, puis ferme le plan.
      void autosave.flush().finally(() => {
        autosave.dispose();
        if (planStore.getState().doc?.plan.id === planId) planStore.getState().load(null);
      });
    };
  }, [planId]);

  return { state, saveError };
}
