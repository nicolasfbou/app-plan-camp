/** Actions de synchronisation depuis l'interface (dans l'onglet du moteur ou dans un autre). */
import { ACTIVE_PROFILE } from '@/app/profile.ts';
import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import { openPlanIds } from '@/persistence/planLock.ts';
import { api } from '../api.ts';
import { kickSync, postSync } from '../bus.ts';
import { SyncEngine } from '../engine.ts';
import { localEngine } from '../runtime.ts';

let fallback: SyncEngine | null = null;

/** Moteur pour une action ponctuelle (résolution de conflit, nouvel essai…). */
export function actionEngine(): SyncEngine {
  const engine = localEngine();
  if (engine) return engine;
  fallback ??= new SyncEngine({
    raw: new IndexedDbRepository(ACTIVE_PROFILE.dbName),
    api,
    orgId: ACTIVE_PROFILE.orgId!,
    openPlanIds,
    post: postSync,
  });
  return fallback;
}

export async function afterAction() {
  kickSync();
}
