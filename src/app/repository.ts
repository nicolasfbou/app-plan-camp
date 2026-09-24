import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import { api } from '@/sync/api.ts';
import { kickSync } from '@/sync/bus.ts';
import { SyncingRepository } from '@/sync/syncingRepository.ts';
import { ACTIVE_PROFILE, currentAccessEpoch } from './profile.ts';

/**
 * Dépôt de l'espace actif :
 * - espace local : IndexedDB seul (phases 1 à 8, inchangé) ;
 * - espace d'organisation : sa propre base IndexedDB + file de synchronisation (le travail reste
 *   local d'abord, le serveur reçoit ensuite).
 */
export const repository: IndexedDbRepository =
  ACTIVE_PROFILE.kind === 'org' && ACTIVE_PROFILE.orgId
    ? new SyncingRepository(
        ACTIVE_PROFILE.dbName,
        ACTIVE_PROFILE.orgId,
        api,
        kickSync,
        async () => {
          // Chargé à la demande (évite une dépendance circulaire au démarrage).
          const { actionEngine } = await import('@/sync/ui/actions.ts');
          await actionEngine().runOnce();
        },
        () => currentAccessEpoch(ACTIVE_PROFILE.id),
      )
    : new IndexedDbRepository(ACTIVE_PROFILE.dbName);
