import Dexie, { type Table } from 'dexie';
import { newId } from '@/domain/model/factories.ts';
import type { PlanDocument, PlanKind, Site } from '@/domain/model/types.ts';
import { sha256Hex } from '@/domain/image/hash.ts';
import { parsePlanDocument } from '@/domain/schema/serialization.ts';
import type { ViewCenter } from '@/domain/viewport/viewport.ts';
import type { PlanSummary, ProjectRepository, StoredBlob } from './ProjectRepository.ts';

/**
 * Enregistrement d'un plan : le document complet (versionné) + un résumé dénormalisé.
 * Le résumé permet de lister et de supprimer les plans sans relire les documents : un plan
 * corrompu ne bloque donc ni la liste des plans ni la suppression des autres.
 */
interface PlanRecord {
  id: string;
  siteId: string;
  name: string;
  kind: PlanKind;
  updatedAt: string;
  /** Fichiers binaires référencés (photo d'origine, PDF d'origine). */
  blobIds: string[];
  /** Date (ms) de l'écriture de cet enregistrement. */
  savedAt?: number;
  /** Document brut : relu via `parsePlanDocument`, donc migré et validé à chaque chargement. */
  document: unknown;
}

interface ViewPrefsRecord extends ViewCenter {
  planId: string;
}

class CampPlannerDatabase extends Dexie {
  sites!: Table<Site, string>;
  plans!: Table<PlanRecord, string>;
  blobs!: Table<StoredBlob, string>;
  viewPrefs!: Table<ViewPrefsRecord, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      sites: 'id, name, updatedAt',
      plans: 'id, siteId, updatedAt, *blobIds',
      blobs: 'id',
    });
    this.version(2).stores({ viewPrefs: 'planId' });
  }
}

/** Identifiants des fichiers binaires référencés par un document de plan. */
/** Fichiers référencés par un plan : photo (et PDF d'origine), pictogrammes importés. */
function blobIdsOf(doc: PlanDocument): string[] {
  const image = doc.plan.baseImage;
  const ids = image
    ? image.source.kind === 'pdf'
      ? [image.blobId, image.source.pdfBlobId]
      : [image.blobId]
    : [];
  for (const asset of Object.values(doc.assets)) ids.push(asset.blobId);
  return [...new Set(ids)];
}

export class IndexedDbRepository implements ProjectRepository {
  private readonly db: CampPlannerDatabase;

  constructor(databaseName = 'campplanner') {
    this.db = new CampPlannerDatabase(databaseName);
  }

  close(): void {
    this.db.close();
  }

  async listSites(): Promise<Site[]> {
    return this.db.sites.orderBy('name').toArray();
  }

  async getSite(id: string): Promise<Site | undefined> {
    return this.db.sites.get(id);
  }

  async saveSite(site: Site): Promise<void> {
    await this.db.sites.put(site);
  }

  async deleteSite(id: string): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.sites, this.db.plans, this.db.blobs, this.db.viewPrefs],
      async () => {
        const planIds = (await this.db.plans.where('siteId').equals(id).primaryKeys()) as string[];
        for (const planId of planIds) await this.deletePlan(planId);
        await this.db.sites.delete(id);
      },
    );
  }

  async listPlans(siteId: string): Promise<PlanSummary[]> {
    const records = await this.db.plans.where('siteId').equals(siteId).toArray();
    return records
      .map(({ id, siteId, name, kind, updatedAt }) => ({ id, siteId, name, kind, updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  async loadPlan(id: string): Promise<PlanDocument | undefined> {
    const record = await this.db.plans.get(id);
    return record ? parsePlanDocument(record.document) : undefined;
  }

  async savePlan(doc: PlanDocument): Promise<void> {
    await this.db.plans.put({
      id: doc.plan.id,
      siteId: doc.plan.siteId,
      name: doc.plan.name,
      kind: doc.plan.kind,
      updatedAt: doc.plan.updatedAt,
      blobIds: blobIdsOf(doc),
      savedAt: Date.now(),
      document: doc,
    });
  }

  async getPlanSummary(id: string): Promise<PlanSummary | undefined> {
    const record = await this.db.plans.get(id);
    if (!record) return undefined;
    const { siteId, name, kind, updatedAt } = record;
    return { id, siteId, name, kind, updatedAt };
  }

  async saveImportedPlan(doc: PlanDocument, newSite: Site | null): Promise<void> {
    await this.db.transaction('rw', this.db.sites, this.db.plans, this.db.blobs, async () => {
      if (newSite) await this.db.sites.put(newSite);
      const previous = await this.db.plans.get(doc.plan.id);
      await this.savePlan(doc);
      for (const blobId of previous?.blobIds ?? []) {
        const references = await this.db.plans.where('blobIds').equals(blobId).count();
        if (references === 0) await this.db.blobs.delete(blobId);
      }
    });
  }

  async getPlanSavedAt(id: string): Promise<number | undefined> {
    return (await this.db.plans.get(id))?.savedAt;
  }

  async deletePlan(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.plans, this.db.blobs, this.db.viewPrefs, async () => {
      const record = await this.db.plans.get(id);
      if (!record) return;
      await this.db.plans.delete(id);
      await this.db.viewPrefs.delete(id);
      // Un fichier peut être partagé par plusieurs plans (duplication) : on ne supprime
      // que ceux qui ne sont plus référencés par aucun plan restant.
      for (const blobId of record.blobIds) {
        const references = await this.db.plans.where('blobIds').equals(blobId).count();
        if (references === 0) await this.db.blobs.delete(blobId);
      }
    });
  }

  async putBlob(bytes: ArrayBuffer, mimeType: string): Promise<Omit<StoredBlob, 'bytes'>> {
    const meta = {
      id: newId(),
      mimeType,
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      createdAt: new Date().toISOString(),
    };
    await this.db.blobs.put({ ...meta, bytes });
    return meta;
  }

  async getBlob(id: string): Promise<StoredBlob | undefined> {
    return this.db.blobs.get(id);
  }

  async deleteOrphanBlobs(minAgeMs = 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - minAgeMs;
    return this.db.transaction('rw', this.db.plans, this.db.blobs, async () => {
      const ids = (await this.db.blobs.toCollection().primaryKeys()) as string[];
      let deleted = 0;
      for (const id of ids) {
        if ((await this.db.plans.where('blobIds').equals(id).count()) > 0) continue;
        // Lecture complète nécessaire pour la date ; seuls les orphelins sont lus.
        const blob = await this.db.blobs.get(id);
        const created = blob?.createdAt ? Date.parse(blob.createdAt) : 0;
        if (created <= cutoff) {
          await this.db.blobs.delete(id);
          deleted++;
        }
      }
      return deleted;
    });
  }

  async getViewPrefs(planId: string): Promise<ViewCenter | undefined> {
    const record = await this.db.viewPrefs.get(planId);
    if (!record) return undefined;
    const { centerX, centerY, scale } = record;
    return { centerX, centerY, scale };
  }

  async saveViewPrefs(planId: string, view: ViewCenter): Promise<void> {
    await this.db.viewPrefs.put({ planId, ...view });
  }
}
