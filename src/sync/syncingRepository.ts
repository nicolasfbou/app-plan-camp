/**
 * Dépôt d'un espace d'organisation : EXACTEMENT le dépôt local (IndexedDB, phases 1–8), plus la
 * mise en file d'une opération de synchronisation après chaque écriture locale réussie.
 *
 *   geste terminé → écriture locale (+ journal de récupération) → IndexedDB → file de synchro
 *
 * L'éditeur ne parle jamais au réseau : il écrit localement, que le serveur soit joignable ou non.
 * Seuls les changements de statut d'une révision (dont l'approbation) passent par le serveur,
 * EN LIGNE : leur date officielle et l'autorisation viennent du serveur.
 */
import type { PlanDocument, Site } from '@/domain/model/types.ts';
import {
  revisionMetaSchema,
  type FrozenRevision,
  type RevisionMeta,
  type StatusChange,
} from '@/domain/revisions/revision.ts';
import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import type { ImportedRevision, StoredTemplate } from '@/persistence/ProjectRepository.ts';
import { type Api, ApiError, type ServerRevision } from './api.ts';
import { Outbox } from './outbox.ts';
import { entityKey } from './types.ts';

export class OnlineRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnlineRequiredError';
  }
}

export class SyncingRepository extends IndexedDbRepository {
  readonly outbox: Outbox;
  /** Origine des plans importés (audit serveur) : import d'un .campplan ou publication d'un projet local. */
  importOrigin: 'import' | 'publish' = 'import';

  constructor(
    databaseName: string,
    readonly organizationId: string,
    private readonly api: Api,
    onEnqueue: () => void = () => undefined,
    /** Envoi immédiat de la file (avant une action serveur qui dépend d'éléments pas encore envoyés). */
    private readonly flush: () => Promise<void> = async () => undefined,
  ) {
    super(databaseName);
    this.outbox = new Outbox(this.sync, organizationId, onEnqueue);
  }

  override async saveSite(site: Site): Promise<void> {
    await super.saveSite(site);
    await this.outbox.enqueue({
      kind: 'camp.upsert',
      entityType: 'camp',
      entityId: site.id,
      label: site.name,
    });
  }

  override async deleteSite(id: string): Promise<void> {
    const site = await super.getSite(id);
    const plans = await super.listPlans(id);
    await super.deleteSite(id);
    for (const p of plans)
      await this.outbox.enqueue({
        kind: 'plan.delete',
        entityType: 'plan',
        entityId: p.id,
        label: p.name,
        planId: p.id,
      });
    await this.outbox.enqueue({
      kind: 'camp.delete',
      entityType: 'camp',
      entityId: id,
      label: site?.name ?? id,
      dependsOn: plans.map((p) => entityKey('plan', p.id)),
    });
  }

  override async savePlan(doc: PlanDocument, options: { expectedVersion?: number } = {}): Promise<number> {
    const version = await super.savePlan(doc, options);
    await this.outbox.enqueuePlan(doc);
    return version;
  }

  override async saveImportedPlan(
    doc: PlanDocument,
    newSite: Site | null,
    revisions: ImportedRevision[] = [],
  ) {
    await super.saveImportedPlan(doc, newSite, revisions);
    if (newSite)
      await this.outbox.enqueue({
        kind: 'camp.upsert',
        entityType: 'camp',
        entityId: newSite.id,
        label: newSite.name,
      });
    await this.outbox.enqueuePlan(doc, this.importOrigin);
    for (const r of revisions) await this.enqueueRevision(r.meta, doc.plan.siteId);
  }

  override async deletePlan(id: string): Promise<void> {
    const summary = await super.getPlanSummary(id);
    await super.deletePlan(id);
    await this.outbox.enqueue({
      kind: 'plan.delete',
      entityType: 'plan',
      entityId: id,
      label: summary?.name ?? id,
      planId: id,
    });
  }

  override async createRevision(revision: FrozenRevision): Promise<void> {
    await super.createRevision(revision);
    const summary = await super.getPlanSummary(revision.meta.planId);
    await this.enqueueRevision(revision.meta, summary?.siteId);
  }

  private async enqueueRevision(meta: RevisionMeta, campId?: string) {
    await this.outbox.enqueue({
      kind: 'revision.create',
      entityType: 'revision',
      entityId: meta.id,
      label: `Révision ${meta.label}`,
      dependsOn: [entityKey('plan', meta.planId)],
      planId: meta.planId,
      ...(campId ? { campId } : {}),
    });
  }

  override async deleteRevision(id: string): Promise<void> {
    const loaded = await super.loadRevision(id).catch(() => null);
    await super.deleteRevision(id);
    await this.outbox.enqueue({
      kind: 'revision.delete',
      entityType: 'revision',
      entityId: id,
      label: `Révision ${loaded?.meta.label ?? id}`,
      ...(loaded ? { planId: loaded.meta.planId } : {}),
    });
  }

  /**
   * Changement de statut / approbation : fait PAR LE SERVEUR (compte, rôle, date serveur, audit),
   * puis la révision scellée par le serveur est enregistrée localement telle quelle.
   */
  override async setRevisionStatus(id: string, change: StatusChange): Promise<RevisionMeta> {
    const pendingCreate = async () =>
      (await this.outbox.list()).some((o) => o.entityId === id && o.kind === 'revision.create');
    if (await pendingCreate()) await this.flush().catch(() => undefined);
    if (await pendingCreate())
      throw new OnlineRequiredError(
        'Cette révision n’est pas encore envoyée au serveur : synchronisez d’abord, puis changez son statut.',
      );
    let result: ServerRevision;
    try {
      result = await this.api.request<ServerRevision>(
        'POST',
        `/api/revisions/${encodeURIComponent(id)}/status`,
        {
          body: { to: change.to, comment: change.comment, confirmed: change.confirmed ?? false },
        },
      );
    } catch (error) {
      if (error instanceof ApiError && error.network)
        throw new OnlineRequiredError(
          'Connexion au serveur requise : l’approbation et les changements de statut sont enregistrés par le serveur (date officielle, compte vérifié).',
        );
      throw error;
    }
    const meta = revisionMetaSchema.parse(result.meta);
    await super.replaceRevisionMeta(id, meta);
    return meta;
  }

  override async saveTemplate(entry: StoredTemplate): Promise<void> {
    await super.saveTemplate(entry);
    await this.outbox.enqueue({
      kind: 'template.upsert',
      entityType: 'template',
      entityId: entry.template.id,
      label: `Modèle « ${entry.template.name} »`,
    });
  }

  override async deleteTemplate(id: string): Promise<void> {
    const entry = await super.getTemplate(id);
    await super.deleteTemplate(id);
    await this.outbox.enqueue({
      kind: 'template.delete',
      entityType: 'template',
      entityId: id,
      label: `Modèle « ${entry?.template.name ?? id} »`,
    });
  }
}
