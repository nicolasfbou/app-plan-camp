/**
 * Révisions du plan ouvert : liste des métadonnées (jamais les instantanés complets), boîtes de
 * dialogue ouvertes, et petit cache des révisions chargées (elles sont figées : un cache ne peut
 * jamais devenir faux ; il est borné pour ne pas garder 20 plans complets en mémoire).
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { repository } from '@/app/repository.ts';
import type { LoadedRevision, RevisionEntry } from '@/persistence/ProjectRepository.ts';
import type { RevisionMeta } from '@/domain/revisions/revision.ts';

/** Un côté d'une comparaison : une révision figée ou le brouillon courant. */
export type CompareSide = { kind: 'revision'; id: string } | { kind: 'draft' };

export type RevisionDialog =
  | { kind: 'create' }
  | { kind: 'view'; id: string }
  | { kind: 'compare'; before: CompareSide; after: CompareSide }
  | { kind: 'status'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'restore'; id: string };

interface RevisionsState {
  planId: string | null;
  entries: RevisionEntry[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  dialog: RevisionDialog | null;
  load(planId: string | null): Promise<void>;
  refresh(): Promise<void>;
  open(dialog: RevisionDialog): void;
  close(): void;
}

const CACHE_SIZE = 4;
const cache = new Map<string, Promise<LoadedRevision>>();

/** Révision chargée (vérifiée, figée), avec un cache borné. */
export function loadRevisionCached(id: string): Promise<LoadedRevision> {
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const promise = repository.loadRevision(id);
  cache.set(id, promise);
  promise.catch(() => cache.delete(id));
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return promise;
}

export const useRevisionsStore = create<RevisionsState>()((set, get) => ({
  planId: null,
  entries: [],
  status: 'idle',
  error: null,
  dialog: null,
  async load(planId) {
    cache.clear();
    set({ planId, entries: [], status: planId ? 'loading' : 'idle', error: null, dialog: null });
    if (planId) await get().refresh();
  },
  async refresh() {
    const { planId } = get();
    if (!planId) return;
    try {
      const entries = await repository.listRevisions(planId);
      if (get().planId === planId) set({ entries, status: 'ready', error: null });
    } catch (e) {
      if (get().planId === planId)
        set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));

/** Métadonnées lisibles, dans l'ordre de création. */
export function useRevisionMetas(): RevisionMeta[] {
  const entries = useRevisionsStore((s) => s.entries);
  return useMemo(() => entries.flatMap((e) => (e.meta ? [e.meta] : [])), [entries]);
}

export function forgetRevision(id: string) {
  cache.delete(id);
}
