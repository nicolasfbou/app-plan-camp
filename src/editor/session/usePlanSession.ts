/**
 * Ouverture d'un plan : chargement validé, sauvegarde automatique branchée, écriture forcée
 * quand l'onglet est masqué ou fermé, et avertissement si des modifications sont en attente.
 */
import { useEffect, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { t } from '@/i18n/index.ts';
import { startAutosave } from '@/persistence/autosave.ts';
import { planStore, selectIsDirty } from '@/store/planStore.ts';

export type SessionState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

export function usePlanSession(planId: string) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    // Le composant appelant est remonté pour chaque plan : l'état initial est déjà « loading ».
    let cancelled = false;
    repository.loadPlan(planId).then(
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
        await repository.savePlan(doc);
        setSaveError(null);
      },
      onError: (error) => setSaveError(error instanceof Error ? error.message : String(error)),
    });
    const flush = () => void autosave.flush();
    const onVisibility = () => document.visibilityState === 'hidden' && flush();
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
