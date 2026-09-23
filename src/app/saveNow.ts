import { repository } from './repository.ts';
import { planStore, selectIsDirty } from '@/store/planStore.ts';

/** Écrit tout de suite les modifications en attente (avant un export, une variante, une révision). */
export async function saveNow(): Promise<void> {
  const state = planStore.getState();
  if (state.doc && selectIsDirty(state)) {
    await repository.savePlan(state.doc);
    if (planStore.getState().revision === state.revision) state.markSaved(state.revision);
  }
}
