/**
 * Nettoyage manuel des ressources : l'espace récupéré est affiché AVANT toute suppression.
 * Jamais : un fichier référencé par un plan ou par une révision (revérifié au moment de supprimer),
 * ni le contenu d'une révision figée. Les pictogrammes inutilisés sont retirés du BROUILLON d'un
 * plan seulement s'il n'est pas modifié ailleurs (version contrôlée).
 */
import type { PlanDocument } from '@/domain/model/types.ts';
import type { OrphanBlob, ProjectRepository } from '@/persistence/ProjectRepository.ts';
import { openPlanIds } from '@/persistence/planLock.ts';
import { recoveryJournalTexts, recoveryKey } from '@/persistence/recovery.ts';
import { recoveryJournalPlanIds } from './health.ts';

export type CleanupKind =
  | 'orphan-photos'
  | 'orphan-pdfs'
  | 'orphan-symbols'
  | 'unused-symbols'
  | 'stale-journals'
  | 'stale-view-prefs';

export interface CleanupItem {
  kind: CleanupKind;
  label: string;
  count: number;
  /** Espace récupéré (estimé pour les pictogrammes inutilisés : dépend des révisions). */
  bytes: number;
  estimated?: boolean;
  /** Données internes de l'opération. */
  orphanIds?: string[];
  unused?: { planId: string; assetIds: string[] }[];
  planIds?: string[];
}

const usedAssetIds = (doc: PlanDocument): Set<string> => {
  const used = new Set<string>();
  for (const o of Object.values(doc.objects)) {
    if (o.type === 'icon' && o.symbolId.startsWith('asset:')) used.add(o.symbolId.slice('asset:'.length));
    if (o.type === 'zone' && o.icon?.symbolId.startsWith('asset:'))
      used.add(o.icon.symbolId.slice('asset:'.length));
  }
  if (doc.plan.titleBlock.logoAssetId) used.add(doc.plan.titleBlock.logoAssetId);
  return used;
};

/** Un fichier orphelin récent peut appartenir à un import en cours (autre onglet) : conservé. */
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
export const oldEnough = (o: OrphanBlob, now = Date.now()) =>
  !o.createdAt || Date.parse(o.createdAt) <= now - ORPHAN_MIN_AGE_MS;

export async function planCleanup(repo: ProjectRepository): Promise<CleanupItem[]> {
  const items: CleanupItem[] = [];
  const orphans = (await repo.listOrphanBlobs(recoveryJournalTexts())).filter((o) => oldEnough(o));
  const group = (kind: CleanupKind, label: string, filter: (o: OrphanBlob) => boolean) => {
    const list = orphans.filter(filter);
    if (list.length)
      items.push({
        kind,
        label,
        count: list.length,
        bytes: list.reduce((s, o) => s + o.byteLength, 0),
        orphanIds: list.map((o) => o.id),
      });
  };
  group(
    'orphan-photos',
    'Photos et images de fond orphelines (dont PDF rastérisés remplacés)',
    (o) => o.mimeType.startsWith('image/') && o.byteLength > 256 * 1024,
  );
  group('orphan-pdfs', 'PDF d’origine orphelins', (o) => o.mimeType === 'application/pdf');
  group(
    'orphan-symbols',
    'Pictogrammes et petits fichiers orphelins',
    (o) =>
      o.mimeType !== 'application/pdf' && !(o.mimeType.startsWith('image/') && o.byteLength > 256 * 1024),
  );

  // Pictogrammes importés présents dans un brouillon mais utilisés par aucun objet ni logo.
  const unused: { planId: string; assetIds: string[] }[] = [];
  let bytes = 0;
  // Plans enregistrés (clés de la table) : un plan dont le camp manque n'est jamais « supprimé ».
  const planIds = new Set(await repo.listPlanIds());
  for (const site of await repo.listSites())
    for (const summary of await repo.listPlans(site.id)) {
      let doc: PlanDocument | undefined;
      try {
        doc = await repo.loadPlan(summary.id);
      } catch {
        continue; // plan illisible : signalé par le centre de santé, jamais touché ici
      }
      if (!doc) continue;
      const used = usedAssetIds(doc);
      const ids = Object.keys(doc.assets).filter((id) => !used.has(id));
      if (!ids.length) continue;
      unused.push({ planId: summary.id, assetIds: ids });
      bytes += ids.reduce((s, id) => s + (doc.assets[id]?.byteLength ?? 0), 0);
    }
  if (unused.length)
    items.push({
      kind: 'unused-symbols',
      label:
        'Pictogrammes importés inutilisés (brouillons ; conservés dans les révisions qui les contiennent)',
      count: unused.reduce((s, u) => s + u.assetIds.length, 0),
      bytes,
      estimated: true,
      unused,
    });

  const staleJournals = recoveryJournalPlanIds().filter((id) => !planIds.has(id));
  if (staleJournals.length)
    items.push({
      kind: 'stale-journals',
      label: 'Journaux de récupération de plans supprimés (sauvegardes temporaires)',
      count: staleJournals.length,
      bytes: staleJournals.reduce((s, id) => s + (localStorage.getItem(recoveryKey(id))?.length ?? 0) * 2, 0),
      planIds: staleJournals,
    });
  const stalePrefs = (await repo.listViewPrefPlanIds()).filter((id) => !planIds.has(id));
  if (stalePrefs.length)
    items.push({
      kind: 'stale-view-prefs',
      label: 'Préférences de vue de plans supprimés',
      count: stalePrefs.length,
      bytes: stalePrefs.length * 64,
      estimated: true,
      planIds: stalePrefs,
    });
  return items;
}

export interface CleanupResult {
  kind: CleanupKind;
  done: number;
  bytes: number;
  skipped: string[];
}

/** Plans ouverts en édition (verrou détenu, dans cet onglet ou un autre). */
export async function applyCleanup(
  repo: ProjectRepository,
  items: readonly CleanupItem[],
  isOpen: () => Promise<Set<string>> = openPlanIds,
): Promise<CleanupResult[]> {
  const results: CleanupResult[] = [];
  const open = await isOpen().catch(() => new Set<string>());
  for (const item of items) {
    const result: CleanupResult = { kind: item.kind, done: 0, bytes: 0, skipped: [] };
    if (item.orphanIds) {
      const r = await repo.deleteBlobs(item.orphanIds, recoveryJournalTexts());
      result.done = r.deleted;
      result.bytes = r.bytes;
    }
    if (item.unused)
      for (const { planId, assetIds } of item.unused) {
        const opened = await repo.openPlan(planId);
        if (opened && open.has(planId)) {
          result.skipped.push(
            `${opened.doc.plan.name} : plan ouvert en édition (fermez-le pour le nettoyer).`,
          );
          continue;
        }
        if (!opened) continue;
        const doc = structuredClone(opened.doc);
        const used = usedAssetIds(doc);
        const blobIds: string[] = [];
        for (const id of assetIds)
          if (!used.has(id) && doc.assets[id]) {
            blobIds.push(doc.assets[id].blobId);
            delete doc.assets[id];
          }
        try {
          // Version contrôlée : un plan modifié ailleurs entre-temps n'est pas touché.
          await repo.savePlan(doc, { expectedVersion: opened.version });
          result.done += blobIds.length;
          const r = await repo.deleteBlobs(blobIds, recoveryJournalTexts()); // seulement ceux devenus orphelins
          result.bytes += r.bytes;
        } catch (error) {
          result.skipped.push(`${doc.plan.name} : ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    if (item.kind === 'stale-journals')
      for (const id of item.planIds ?? []) {
        localStorage.removeItem(recoveryKey(id));
        result.done++;
      }
    if (item.kind === 'stale-view-prefs')
      for (const id of item.planIds ?? []) {
        await repo.deleteViewPrefs(id);
        result.done++;
      }
    results.push(result);
  }
  return results;
}
