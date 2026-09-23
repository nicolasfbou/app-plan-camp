/**
 * Session du plan ouvert : version enregistrée connue, mode du verrou d'édition (éditeur / lecture
 * seule), conflit éventuel. Toute écriture du plan ouvert passe par `persistOpenPlan`, qui vérifie
 * la version : un plan modifié ailleurs (autre onglet, import) n'est jamais écrasé en silence.
 *
 * Chaque plan ouvert a SA session (`sessions`), conservée jusqu'à sa dernière écriture : quand
 * on passe directement d'un plan X à un plan Y, l'écriture finale de X vérifie toujours la
 * version de X (jamais d'écriture sans contrôle). Les champs de premier niveau reflètent le plan
 * affiché, pour l'interface.
 */
import { create } from 'zustand';
import { repository } from '@/app/repository.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { logEvent } from '@/diagnostics/errorLog.ts';
import type { LockMode, PlanLock } from '@/persistence/planLock.ts';
import { PlanConflictError } from '@/persistence/ProjectRepository.ts';

export interface PlanSession {
  /** Version enregistrée sur laquelle repose le brouillon ouvert. */
  version: number;
  lockMode: LockMode;
  lock: PlanLock | null;
  /** Identifie l'ouverture (un même plan peut être rouvert avant la fin de la précédente). */
  token: number;
  /**
   * Conflit : `version` (plan enregistré ailleurs), `deleted` (plan supprimé ailleurs),
   * `handover` (la main a été reprise par un autre onglet alors que des modifications n'étaient
   * pas enregistrées ici).
   */
  conflict: { storedVersion: number; reason?: 'version' | 'deleted' | 'handover' } | null;
}

export interface SessionState extends PlanSession {
  planId: string | null;
  sessions: Record<string, PlanSession>;
  /** Ouvre la session d'un plan ; retourne son jeton (à passer à `end`). */
  begin(planId: string, lock: PlanLock | null): number;
  update(planId: string, partial: Partial<PlanSession>): void;
  setVersion(planId: string, version: number): void;
  setLockMode(planId: string, mode: LockMode): void;
  setConflict(planId: string, conflict: PlanSession['conflict']): void;
  end(planId: string, token: number): void;
}

const EMPTY: PlanSession = { version: 0, lockMode: 'pending', lock: null, conflict: null, token: 0 };
let nextToken = 1;

export const useSessionStore = create<SessionState>()((set, get) => ({
  planId: null,
  ...EMPTY,
  sessions: {},
  begin: (planId, lock) => {
    const entry: PlanSession = { ...EMPTY, lock, lockMode: lock?.mode ?? 'unsupported', token: nextToken++ };
    set({ planId, ...entry, sessions: { ...get().sessions, [planId]: entry } });
    return entry.token;
  },
  update: (planId, partial) => {
    const current = get().sessions[planId];
    if (!current) return;
    const entry = { ...current, ...partial };
    set({
      sessions: { ...get().sessions, [planId]: entry },
      ...(get().planId === planId ? entry : {}),
    });
  },
  setVersion: (planId, version) => get().update(planId, { version }),
  setLockMode: (planId, lockMode) => get().update(planId, { lockMode }),
  setConflict: (planId, conflict) => get().update(planId, { conflict }),
  end: (planId, token) => {
    if (get().sessions[planId]?.token !== token) return; // plan rouvert entre-temps : on garde
    const sessions = { ...get().sessions };
    delete sessions[planId];
    set({ sessions, ...(get().planId === planId ? { planId: null, ...EMPTY } : {}) });
  },
}));

export const planSession = (planId: string): PlanSession | undefined =>
  useSessionStore.getState().sessions[planId];

/** Écriture refusée (lecture seule, conflit en attente) : les modifications restent « non enregistrées ». */
export class SaveSkippedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveSkippedError';
  }
}

/**
 * Écrit le plan ouvert avec contrôle de version. Lève `PlanConflictError` (et ouvre le conflit)
 * si le plan enregistré a changé ; `SaveSkippedError` en lecture seule, pendant un conflit ou
 * pour un plan sans session (jamais d'écriture sans contrôle de version).
 */
export async function persistOpenPlan(doc: PlanDocument): Promise<void> {
  const planId = doc.plan.id;
  const session = planSession(planId);
  if (!session) throw new SaveSkippedError('Plan fermé : écriture sans contrôle de version refusée.');
  if (session.lockMode === 'readonly')
    throw new SaveSkippedError('Plan ouvert en lecture seule : rien n’est enregistré ici.');
  if (session.conflict) throw new PlanConflictError(planId, session.conflict.storedVersion, session.version);
  try {
    const version = await repository.savePlan(doc, { expectedVersion: session.version });
    useSessionStore.getState().setVersion(planId, version);
    session.lock?.announceSaved(version);
  } catch (error) {
    if (error instanceof PlanConflictError) {
      const deleted = (await repository.getPlanVersion(planId)) === undefined;
      useSessionStore.getState().setConflict(planId, {
        storedVersion: error.storedVersion,
        reason: deleted ? 'deleted' : 'version',
      });
      logEvent('conflict', error, { context: `plan ${planId}` });
    }
    throw error;
  }
}
