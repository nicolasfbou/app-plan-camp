/**
 * Session du plan ouvert : version enregistrée connue, mode du verrou d'édition (éditeur / lecture
 * seule), conflit éventuel. Toute écriture du plan ouvert passe par `persistOpenPlan`, qui vérifie
 * la version : un plan modifié ailleurs (autre onglet, import) n'est jamais écrasé en silence.
 */
import { create } from 'zustand';
import { repository } from '@/app/repository.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { logEvent } from '@/diagnostics/errorLog.ts';
import type { LockMode, PlanLock } from '@/persistence/planLock.ts';
import { PlanConflictError } from '@/persistence/ProjectRepository.ts';

export interface SessionState {
  planId: string | null;
  /** Version enregistrée sur laquelle repose le brouillon ouvert. */
  version: number;
  lockMode: LockMode;
  lock: PlanLock | null;
  conflict: { storedVersion: number } | null;
  begin(planId: string, lock: PlanLock | null): void;
  setVersion(version: number): void;
  setLockMode(mode: LockMode): void;
  setConflict(conflict: SessionState['conflict']): void;
  end(planId: string): void;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  planId: null,
  version: 0,
  lockMode: 'pending',
  lock: null,
  conflict: null,
  begin: (planId, lock) =>
    set({ planId, lock, version: 0, lockMode: lock?.mode ?? 'unsupported', conflict: null }),
  setVersion: (version) => set({ version }),
  setLockMode: (lockMode) => set({ lockMode }),
  setConflict: (conflict) => set({ conflict }),
  end: (planId) => {
    if (get().planId === planId)
      set({ planId: null, lock: null, conflict: null, version: 0, lockMode: 'pending' });
  },
}));

/**
 * Écrit le plan ouvert avec contrôle de version. Lève `PlanConflictError` (et ouvre le conflit)
 * si le plan enregistré a changé ; refuse d'écrire en lecture seule ou pendant un conflit.
 */
export async function persistOpenPlan(doc: PlanDocument): Promise<void> {
  const session = useSessionStore.getState();
  if (session.planId !== doc.plan.id) {
    await repository.savePlan(doc);
    return;
  }
  if (session.lockMode === 'readonly')
    throw new Error('Plan ouvert en lecture seule : rien n’est enregistré ici.');
  if (session.conflict)
    throw new PlanConflictError(doc.plan.id, session.conflict.storedVersion, session.version);
  try {
    const version = await repository.savePlan(doc, { expectedVersion: session.version });
    useSessionStore.getState().setVersion(version);
    session.lock?.announceSaved(version);
  } catch (error) {
    if (error instanceof PlanConflictError) {
      useSessionStore.getState().setConflict({ storedVersion: error.storedVersion });
      logEvent('conflict', error, { context: `plan ${doc.plan.id}` });
    }
    throw error;
  }
}
