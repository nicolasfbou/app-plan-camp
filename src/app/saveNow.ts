import { persistOpenPlan } from '@/editor/session/sessionStore.ts';
import { planStore, selectIsDirty } from '@/store/planStore.ts';

/**
 * Écrit tout de suite les modifications en attente (avant un export, une variante, une révision),
 * avec contrôle de version : lève `PlanConflictError` si le plan a changé ailleurs.
 */
export async function saveNow(): Promise<void> {
  const state = planStore.getState();
  if (state.doc && !state.readOnly && selectIsDirty(state)) {
    await persistOpenPlan(state.doc);
    if (planStore.getState().revision === state.revision) state.markSaved(state.revision);
  }
}
