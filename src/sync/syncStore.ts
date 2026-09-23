/**
 * État de synchronisation affiché (tous les onglets) : relu dans IndexedDB (file, conflits) et
 * complété par l'état du moteur (joignable, en cours, dernière synchro).
 *
 * États : En ligne · synchronisé / Hors ligne / Synchronisation… / Changements locaux (n) /
 * Conflit / Erreur de synchro / Connexion requise.
 */
import { create } from 'zustand';
import type { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import type { EngineStatus } from './engine.ts';
import type { SyncConflictRecord, SyncOperationRecord } from './types.ts';

export type SyncState = 'synced' | 'offline' | 'syncing' | 'local-changes' | 'conflict' | 'error' | 'auth';

export interface PlanSyncInfo {
  state: 'synced' | 'local-changes' | 'conflict' | 'error' | 'local-only' | 'server-update';
}

interface SyncStore {
  enabled: boolean;
  online: boolean;
  engine: EngineStatus | null;
  operations: SyncOperationRecord[];
  conflicts: SyncConflictRecord[];
  serverUpdates: Set<string>;
  linkedPlans: Set<string>;
  set(patch: Partial<SyncStore>): void;
}

export const useSyncStore = create<SyncStore>()((set) => ({
  enabled: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  engine: null,
  operations: [],
  conflicts: [],
  serverUpdates: new Set(),
  linkedPlans: new Set(),
  set: (patch) => set(patch),
}));

export function overallState(
  s: Pick<SyncStore, 'online' | 'engine' | 'operations' | 'conflicts'>,
): SyncState {
  if (s.conflicts.length) return 'conflict';
  if (s.engine?.authRequired) return 'auth';
  if (s.operations.some((o) => o.status === 'failed')) return 'error';
  if (!s.online || s.engine?.reachable === false) return 'offline';
  // Tant que la première synchronisation n'a pas abouti, rien n'est présenté comme « synchronisé ».
  if (!s.engine?.lastSyncAt) return 'syncing';
  if (s.engine.syncing && s.operations.length) return 'syncing';
  if (s.operations.length) return 'local-changes';
  return 'synced';
}

export function planState(s: SyncStore, planId: string): PlanSyncInfo['state'] {
  if (s.conflicts.some((c) => c.planId === planId)) return 'conflict';
  const ops = s.operations.filter((o) => o.planId === planId || o.entityId === planId);
  if (ops.some((o) => o.status === 'failed')) return 'error';
  if (ops.length) return 'local-changes';
  if (s.serverUpdates.has(planId)) return 'server-update';
  return s.linkedPlans.has(planId) ? 'synced' : 'local-only';
}

/** Relit la file, les conflits et les liens (appelé périodiquement et sur message). */
export async function refreshSyncStore(repo: IndexedDbRepository) {
  const t = repo.sync;
  const [operations, conflicts, links] = await Promise.all([
    t.outbox.orderBy('seq').toArray(),
    t.conflicts.toArray(),
    t.syncLinks.where('entityType').equals('plan').toArray(),
  ]);
  const pending = links.filter((l) => l.pendingPull).map((l) => l.entityId);
  useSyncStore.getState().set({
    operations: operations.filter((o) => o.status !== 'done'),
    conflicts,
    linkedPlans: new Set(links.filter((l) => !l.deleted).map((l) => l.entityId)),
    serverUpdates: new Set([...pending]),
  });
}
