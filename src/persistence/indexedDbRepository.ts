import Dexie, { type Table } from 'dexie';
import { newId } from '@/domain/model/factories.ts';
import type { PlanDocument, PlanKind, Site } from '@/domain/model/types.ts';
import { sha256Hex } from '@/domain/image/hash.ts';
import { parsePlanDocument } from '@/domain/schema/serialization.ts';
import type { ViewCenter } from '@/domain/viewport/viewport.ts';
import { templateSchema } from '@/domain/templates/template.ts';
import {
  changeRevisionStatus,
  deepFreeze,
  type FrozenRevision,
  isDeletable,
  isSealIntact,
  referencedBlobIds,
  RevisionError,
  RevisionIntegrityError,
  type RevisionMeta,
  revisionMetaSchema,
  sha256OfText,
  type StatusChange,
  withLocalBlobs,
} from '@/domain/revisions/revision.ts';
import { PlanConflictError } from './ProjectRepository.ts';
import type {
  ImportedRevision,
  LoadedRevision,
  OrphanBlob,
  PlanSummary,
  ProjectRepository,
  RevisionEntry,
  StoredBlob,
  StoredTemplate,
} from './ProjectRepository.ts';

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
  /** Version d'enregistrement (augmente à chaque écriture ; absente = 0). */
  version?: number;
  /** Document brut : relu via `parsePlanDocument`, donc migré et validé à chaque chargement. */
  document: unknown;
}

interface TemplateRecord {
  id: string;
  name: string;
  updatedAt: string;
  /** Modèle brut : relu et validé à chaque lecture. */
  template: unknown;
  logo: ArrayBuffer | null;
}

/**
 * Métadonnées d'une révision (petites : listées sans lire les instantanés). `blobIds` = fichiers
 * locaux référencés par l'instantané (ils ne sont jamais supprimés tant qu'une révision existe).
 */
interface RevisionRecord {
  id: string;
  planId: string;
  createdAt: string;
  blobIds: string[];
  /** Identifiant de fichier dans l'instantané → identifiant local (après un import). */
  blobMap: Record<string, string>;
  /** Métadonnées brutes : relues et validées à chaque lecture. */
  meta: unknown;
}

/** Instantané figé : texte JSON exact, dont l'empreinte est dans les métadonnées. */
interface RevisionSnapshotRecord {
  id: string;
  json: string;
}

interface ViewPrefsRecord extends ViewCenter {
  planId: string;
}

class CampPlannerDatabase extends Dexie {
  sites!: Table<Site, string>;
  plans!: Table<PlanRecord, string>;
  blobs!: Table<StoredBlob, string>;
  viewPrefs!: Table<ViewPrefsRecord, string>;
  templates!: Table<TemplateRecord, string>;
  revisions!: Table<RevisionRecord, string>;
  revisionSnapshots!: Table<RevisionSnapshotRecord, string>;
  settings!: Table<{ key: string; value: unknown }, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      sites: 'id, name, updatedAt',
      plans: 'id, siteId, updatedAt, *blobIds',
      blobs: 'id',
    });
    this.version(2).stores({ viewPrefs: 'planId' });
    this.version(3).stores({ templates: 'id, name, updatedAt' });
    this.version(4).stores({ revisions: 'id, planId, *blobIds', revisionSnapshots: 'id' });
    // Index des empreintes : un fichier déjà stocké (même SHA-256) est réutilisé, jamais dupliqué.
    this.version(5).stores({ blobs: 'id, sha256' });
    this.version(6).stores({ settings: 'key' });
  }
}

/** Fichiers référencés par un plan : photo (et PDF d'origine), pictogrammes importés. */
const blobIdsOf = referencedBlobIds;

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
      [
        this.db.sites,
        this.db.plans,
        this.db.blobs,
        this.db.viewPrefs,
        this.db.revisions,
        this.db.revisionSnapshots,
      ],
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

  async openPlan(id: string): Promise<{ doc: PlanDocument; version: number } | undefined> {
    const record = await this.db.plans.get(id);
    return record ? { doc: parsePlanDocument(record.document), version: record.version ?? 0 } : undefined;
  }

  async savePlan(doc: PlanDocument, options: { expectedVersion?: number } = {}): Promise<number> {
    // Lecture de la version et écriture dans UNE transaction : aucune écriture ne s'intercale.
    return this.db.transaction('rw', this.db.plans, async () => {
      const current = await this.db.plans.get(doc.plan.id);
      const version = current?.version ?? 0;
      if (current && options.expectedVersion !== undefined && options.expectedVersion !== version)
        throw new PlanConflictError(doc.plan.id, version, options.expectedVersion);
      await this.db.plans.put({
        id: doc.plan.id,
        siteId: doc.plan.siteId,
        name: doc.plan.name,
        kind: doc.plan.kind,
        updatedAt: doc.plan.updatedAt,
        blobIds: blobIdsOf(doc),
        savedAt: Date.now(),
        version: version + 1,
        document: doc,
      });
      return version + 1;
    });
  }

  async getPlanVersion(id: string): Promise<number | undefined> {
    const record = await this.db.plans.get(id);
    return record ? (record.version ?? 0) : undefined;
  }

  async getPlanRaw(id: string): Promise<unknown> {
    return (await this.db.plans.get(id))?.document;
  }

  async getPlanSummary(id: string): Promise<PlanSummary | undefined> {
    const record = await this.db.plans.get(id);
    if (!record) return undefined;
    const { siteId, name, kind, updatedAt } = record;
    return { id, siteId, name, kind, updatedAt };
  }

  /** Fichier encore référencé par un plan ou par une révision figée. */
  private async blobInUse(blobId: string): Promise<boolean> {
    return (
      (await this.db.plans.where('blobIds').equals(blobId).count()) > 0 ||
      (await this.db.revisions.where('blobIds').equals(blobId).count()) > 0
    );
  }

  async saveImportedPlan(
    doc: PlanDocument,
    newSite: Site | null,
    revisions: ImportedRevision[] = [],
  ): Promise<void> {
    const prepared = await Promise.all(
      revisions.map((r) =>
        IndexedDbRepository.prepareRevision({ ...r, meta: { ...r.meta, planId: doc.plan.id } }, r.blobMap),
      ),
    );
    await this.db.transaction(
      'rw',
      [this.db.sites, this.db.plans, this.db.blobs, this.db.revisions, this.db.revisionSnapshots],
      async () => {
        if (newSite) await this.db.sites.put(newSite);
        const previous = await this.db.plans.get(doc.plan.id);
        await this.savePlan(doc);
        // Révisions du fichier : ajoutées ; une révision déjà présente n'est JAMAIS remplacée
        // (figée : la version locale, avec son statut et son approbation, fait foi).
        for (const record of prepared) {
          if (await this.db.revisions.get(record.id)) continue;
          await this.putRevision(record);
        }
        for (const blobId of previous?.blobIds ?? [])
          if (!(await this.blobInUse(blobId))) await this.db.blobs.delete(blobId);
      },
    );
  }

  async getPlanSavedAt(id: string): Promise<number | undefined> {
    return (await this.db.plans.get(id))?.savedAt;
  }

  async deletePlan(id: string): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.plans, this.db.blobs, this.db.viewPrefs, this.db.revisions, this.db.revisionSnapshots],
      async () => {
        const record = await this.db.plans.get(id);
        if (!record) return;
        // Les révisions du plan disparaissent avec lui (l'interface l'exige confirmé, deux fois
        // si une révision est approuvée).
        const revisions = await this.db.revisions.where('planId').equals(id).toArray();
        await this.db.revisions.bulkDelete(revisions.map((r) => r.id));
        await this.db.revisionSnapshots.bulkDelete(revisions.map((r) => r.id));
        await this.db.plans.delete(id);
        await this.db.viewPrefs.delete(id);
        // Un fichier peut être partagé par plusieurs plans (duplication) : on ne supprime
        // que ceux qui ne sont plus référencés par aucun plan ni aucune révision restante.
        const blobIds = new Set([...record.blobIds, ...revisions.flatMap((r) => r.blobIds)]);
        for (const blobId of blobIds) if (!(await this.blobInUse(blobId))) await this.db.blobs.delete(blobId);
      },
    );
  }

  // --- Révisions ----------------------------------------------------------------------------

  /**
   * Vérifications d'une révision AVANT toute transaction (le calcul d'empreinte est asynchrone et
   * fermerait une transaction IndexedDB) : empreinte de l'instantané, métadonnées, plan valide.
   */
  private static async prepareRevision(
    revision: FrozenRevision,
    blobMap: Record<string, string>,
  ): Promise<RevisionRecord & { json: string }> {
    const meta = revisionMetaSchema.parse(revision.meta);
    if ((await sha256OfText(revision.json)) !== meta.snapshot.sha256)
      throw new RevisionIntegrityError(`Instantané de la révision ${meta.label} altéré : non enregistré.`);
    if (!(await isSealIntact(meta)))
      throw new RevisionIntegrityError(
        `Révision ${meta.label} altérée (sceau non conforme) : non enregistrée.`,
      );
    // L'instantané doit être un plan valide (migré au besoin) : jamais une révision illisible.
    const doc = withLocalBlobs(parsePlanDocument(revision.json), blobMap);
    return {
      id: meta.id,
      planId: meta.planId,
      createdAt: meta.createdAt,
      blobIds: referencedBlobIds(doc),
      blobMap,
      meta,
      json: revision.json,
    };
  }

  /** Écriture (dans une transaction ouverte sur `blobs`, `revisions`, `revisionSnapshots`). */
  private async putRevision(record: RevisionRecord & { json: string }): Promise<void> {
    const { json, ...meta } = record;
    const label = (meta.meta as RevisionMeta).label;
    for (const blobId of meta.blobIds)
      // Existence seulement (sans lire les octets de la photo).
      if (!(await this.db.blobs.where('id').equals(blobId).count()))
        throw new RevisionError(`Révision ${label} : fichier d’origine introuvable (${blobId}).`);
    await this.db.revisions.put(meta);
    await this.db.revisionSnapshots.put({ id: meta.id, json });
  }

  async listRevisions(planId: string): Promise<RevisionEntry[]> {
    const records = await this.db.revisions.where('planId').equals(planId).toArray();
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return Promise.all(
      records.map(async (r) => {
        const parsed = revisionMetaSchema.safeParse(r.meta);
        return parsed.success
          ? { id: r.id, meta: parsed.data, sealIntact: await isSealIntact(parsed.data) }
          : { id: r.id, meta: null, sealIntact: false };
      }),
    );
  }

  async loadRevision(id: string): Promise<LoadedRevision> {
    const [record, snapshot] = await Promise.all([
      this.db.revisions.get(id),
      this.db.revisionSnapshots.get(id),
    ]);
    if (!record || !snapshot) throw new RevisionError('Révision introuvable.');
    const meta = revisionMetaSchema.parse(record.meta);
    if (!(await isSealIntact(meta)))
      throw new RevisionIntegrityError(`Révision ${meta.label} altérée (sceau non conforme).`);
    if ((await sha256OfText(snapshot.json)) !== meta.snapshot.sha256)
      throw new RevisionIntegrityError(
        `Révision ${meta.label} altérée : l’empreinte SHA-256 de l’instantané ne correspond plus.`,
      );
    const doc = withLocalBlobs(parsePlanDocument(snapshot.json), record.blobMap);
    return { meta, doc: deepFreeze(doc) };
  }

  /** Texte exact de l'instantané et correspondance des fichiers (export `.campplan`). */
  async readRevisionSnapshot(id: string): Promise<{ json: string; blobMap: Record<string, string> }> {
    const [record, snapshot] = await Promise.all([
      this.db.revisions.get(id),
      this.db.revisionSnapshots.get(id),
    ]);
    if (!record || !snapshot) throw new RevisionError('Révision introuvable.');
    return { json: snapshot.json, blobMap: record.blobMap };
  }

  async createRevision(revision: FrozenRevision): Promise<void> {
    const record = await IndexedDbRepository.prepareRevision(revision, {});
    await this.db.transaction(
      'rw',
      [this.db.plans, this.db.blobs, this.db.revisions, this.db.revisionSnapshots],
      async () => {
        const { meta } = revision;
        if (!(await this.db.plans.get(meta.planId))) throw new RevisionError('Plan introuvable.');
        if (await this.db.revisions.get(meta.id)) throw new RevisionError('Cette révision existe déjà.');
        const labels = (await this.db.revisions.where('planId').equals(meta.planId).toArray()).map((r) =>
          String((r.meta as RevisionMeta | undefined)?.label ?? '').toUpperCase(),
        );
        if (labels.includes(meta.label.toUpperCase()))
          throw new RevisionError(`La révision « ${meta.label} » existe déjà pour ce plan.`);
        await this.putRevision(record);
      },
    );
  }

  async setRevisionStatus(
    id: string,
    change: StatusChange,
    now = new Date().toISOString(),
  ): Promise<RevisionMeta> {
    const record = await this.db.revisions.get(id);
    const snapshot = await this.db.revisionSnapshots.get(id);
    if (!record || !snapshot) throw new RevisionError('Révision introuvable.');
    const current = revisionMetaSchema.parse(record.meta);
    // Jamais d'approbation (ni d'autre statut) sur un instantané altéré.
    if ((await sha256OfText(snapshot.json)) !== current.snapshot.sha256)
      throw new RevisionIntegrityError(
        `Révision ${current.label} altérée : l’empreinte SHA-256 de l’instantané ne correspond plus.`,
      );
    // Calcul (asynchrone) hors transaction, puis écriture seulement si rien n'a changé entre-temps.
    const next = await changeRevisionStatus(current, change, now);
    await this.db.transaction('rw', this.db.revisions, async () => {
      const current = await this.db.revisions.get(id);
      if (!current || JSON.stringify(current.meta) !== JSON.stringify(record.meta))
        throw new RevisionError('La révision a changé entre-temps : recommencez.');
      await this.db.revisions.put({ ...current, meta: next });
    });
    return next;
  }

  async deleteRevision(id: string): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.revisions, this.db.revisionSnapshots, this.db.plans, this.db.blobs],
      async () => {
        const record = await this.db.revisions.get(id);
        if (!record) return;
        const parsed = revisionMetaSchema.safeParse(record.meta);
        if (parsed.success && !isDeletable(parsed.data))
          throw new RevisionError(
            `La révision ${parsed.data.label} est approuvée : elle ne peut pas être supprimée.`,
          );
        if (!parsed.success) throw new RevisionError('Révision illisible : suppression refusée.');
        await this.db.revisions.delete(id);
        await this.db.revisionSnapshots.delete(id);
        for (const blobId of record.blobIds)
          if (!(await this.blobInUse(blobId))) await this.db.blobs.delete(blobId);
      },
    );
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

  async findBlobBySha256(sha256: string): Promise<string | undefined> {
    return (await this.db.blobs.where('sha256').equals(sha256).primaryKeys())[0] as string | undefined;
  }

  async getBlob(id: string): Promise<StoredBlob | undefined> {
    return this.db.blobs.get(id);
  }

  async deleteOrphanBlobs(minAgeMs = 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - minAgeMs;
    return this.db.transaction('rw', this.db.plans, this.db.blobs, this.db.revisions, async () => {
      const ids = (await this.db.blobs.toCollection().primaryKeys()) as string[];
      let deleted = 0;
      for (const id of ids) {
        if (await this.blobInUse(id)) continue;
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

  async getSetting<T>(key: string): Promise<T | undefined> {
    return (await this.db.settings.get(key))?.value as T | undefined;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.settings.put({ key, value });
  }

  // --- Maintenance ---------------------------------------------------------------------------

  async listOrphanBlobs(): Promise<OrphanBlob[]> {
    const ids = (await this.db.blobs.toCollection().primaryKeys()) as string[];
    const out: OrphanBlob[] = [];
    for (const id of ids) {
      if (await this.blobInUse(id)) continue;
      const blob = await this.db.blobs.get(id); // seuls les orphelins sont lus
      if (blob)
        out.push({ id, byteLength: blob.byteLength, mimeType: blob.mimeType, createdAt: blob.createdAt });
    }
    return out;
  }

  async deleteBlobs(ids: readonly string[]): Promise<{ deleted: number; bytes: number }> {
    return this.db.transaction('rw', this.db.plans, this.db.blobs, this.db.revisions, async () => {
      let deleted = 0;
      let bytes = 0;
      for (const id of ids) {
        // Jamais un fichier référencé par un plan ou une révision (revérifié ici).
        if (await this.blobInUse(id)) continue;
        const blob = await this.db.blobs.get(id);
        if (!blob) continue;
        await this.db.blobs.delete(id);
        deleted++;
        bytes += blob.byteLength;
      }
      return { deleted, bytes };
    });
  }

  private async expectedIndexes(planId: string) {
    const record = await this.db.plans.get(planId);
    const plan = record ? { record, blobIds: blobIdsOf(parsePlanDocument(record.document)) } : null;
    const revisions = [];
    for (const r of await this.db.revisions.where('planId').equals(planId).toArray()) {
      const snapshot = await this.db.revisionSnapshots.get(r.id);
      if (!snapshot) continue;
      try {
        revisions.push({
          record: r,
          blobIds: referencedBlobIds(withLocalBlobs(parsePlanDocument(snapshot.json), r.blobMap)),
        });
      } catch {
        // Instantané illisible : signalé par le contrôle des révisions, pas ici.
      }
    }
    return { plan, revisions };
  }

  async checkPlanIndex(planId: string): Promise<{ consistent: boolean; details: string[] }> {
    const same = (a: readonly string[], b: readonly string[]) =>
      [...a].sort().join() === [...b].sort().join();
    const { plan, revisions } = await this.expectedIndexes(planId);
    const details: string[] = [];
    if (plan && !same(plan.record.blobIds, plan.blobIds))
      details.push('Index des fichiers du plan incohérent.');
    for (const r of revisions)
      if (!same(r.record.blobIds, r.blobIds))
        details.push(
          `Index des fichiers de la révision ${(r.record.meta as RevisionMeta).label ?? r.record.id} incohérent.`,
        );
    return { consistent: details.length === 0, details };
  }

  async reindexPlan(planId: string): Promise<void> {
    const { plan, revisions } = await this.expectedIndexes(planId);
    await this.db.transaction('rw', this.db.plans, this.db.revisions, async () => {
      if (plan) {
        const current = await this.db.plans.get(planId);
        // Seul l'index change (le document et sa version restent identiques).
        if (current) await this.db.plans.put({ ...current, blobIds: plan.blobIds });
      }
      for (const r of revisions) {
        const current = await this.db.revisions.get(r.record.id);
        if (current) await this.db.revisions.put({ ...current, blobIds: r.blobIds });
      }
    });
  }

  async deleteViewPrefs(planId: string): Promise<void> {
    await this.db.viewPrefs.delete(planId);
  }

  async listViewPrefPlanIds(): Promise<string[]> {
    return (await this.db.viewPrefs.toCollection().primaryKeys()) as string[];
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

  private static readTemplate(record: TemplateRecord): StoredTemplate | undefined {
    const parsed = templateSchema.safeParse(record.template);
    if (!parsed.success) return undefined;
    return { template: parsed.data, logo: record.logo ? new Uint8Array(record.logo) : null };
  }

  async listTemplates(): Promise<StoredTemplate[]> {
    const records = await this.db.templates.orderBy('name').toArray();
    return records.map(IndexedDbRepository.readTemplate).filter((t): t is StoredTemplate => Boolean(t));
  }

  async getTemplate(id: string): Promise<StoredTemplate | undefined> {
    const record = await this.db.templates.get(id);
    return record ? IndexedDbRepository.readTemplate(record) : undefined;
  }

  async saveTemplate(entry: StoredTemplate): Promise<void> {
    const template = templateSchema.parse(entry.template);
    await this.db.templates.put({
      id: template.id,
      name: template.name,
      updatedAt: template.updatedAt,
      template,
      logo: entry.logo ? entry.logo.slice().buffer : null,
    });
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.db.templates.delete(id);
  }
}
