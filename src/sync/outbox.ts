/**
 * File de synchronisation (IndexedDB) : opérations dans l'ordre de leur création, chacune avec
 * ses dépendances (`keys`). Règles :
 * - une modification répétée d'un même élément ne crée pas d'opérations en double (l'envoi lit
 *   l'état enregistré le plus récent) ;
 * - un élément créé puis supprimé avant tout envoi disparaît de la file (rien à envoyer) ;
 * - une opération en échec reste visible avec son erreur ; celles qui en dépendent attendent
 *   (et le disent), les autres continuent. Rien n'est retiré sans action explicite.
 */
import { newId, nowIso } from '@/domain/model/factories.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import type { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import { entityKey, type EntityType, type OperationKind, type SyncOperationRecord } from './types.ts';

type SyncTables = IndexedDbRepository['sync'];

const UPSERTS: ReadonlySet<OperationKind> = new Set([
  'camp.upsert',
  'plan.upsert',
  'template.upsert',
  'file.upload',
]);

export interface EnqueueInput {
  kind: OperationKind;
  entityType: EntityType;
  entityId: string;
  label: string;
  dependsOn?: string[];
  origin?: SyncOperationRecord['origin'];
  planId?: string;
  campId?: string;
}

export class Outbox {
  constructor(
    private readonly tables: SyncTables,
    private readonly orgId: string,
    private readonly notify: () => void = () => undefined,
  ) {}

  async enqueue(input: EnqueueInput): Promise<void> {
    const own = entityKey(input.entityType, input.entityId);
    await this.tables.transaction('rw', this.tables.outbox, this.tables.syncLinks, async () => {
      const same = await this.tables.outbox.where('entityId').equals(input.entityId).toArray();
      const open = same.filter((o) => o.entityType === input.entityType && o.status !== 'done');
      if (UPSERTS.has(input.kind) && open.some((o) => o.kind === input.kind && o.status === 'pending'))
        return;
      const link = await this.tables.syncLinks.get(own);
      let mayExistOnServer = false;
      if (input.kind.endsWith('.delete')) {
        // Un envoi déjà commencé a peut-être atteint le serveur (réponse perdue ou en cours) :
        // la suppression est alors envoyée quand même, après vérification sur le serveur.
        mayExistOnServer = open.some((o) => o.kind !== input.kind && o.attempted);
        // Suppression : les envois en attente de cet élément deviennent inutiles.
        for (const o of open)
          if (o.kind !== input.kind && o.status !== 'blocked') await this.tables.outbox.delete(o.seq!);
        // Jamais envoyé au serveur : rien à supprimer là-bas (ni ses révisions jamais envoyées).
        if (!link && !mayExistOnServer) {
          if (input.entityType === 'plan') {
            const orphans = await this.tables.outbox
              .filter((o) => o.planId === input.entityId && o.status !== 'done' && !o.attempted)
              .toArray();
            for (const o of orphans) await this.tables.outbox.delete(o.seq!);
          }
          return;
        }
      }
      const op: SyncOperationRecord = {
        operationId: `op-${newId()}-${newId()}`,
        kind: input.kind,
        entityType: input.entityType,
        entityId: input.entityId,
        organizationId: this.orgId,
        baseServerVersion: link?.serverVersion ?? null,
        createdAt: nowIso(),
        retryCount: 0,
        status: 'pending',
        lastError: null,
        nextAttemptAt: 0,
        keys: [own, ...(input.dependsOn ?? [])],
        label: input.label,
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.planId ? { planId: input.planId } : {}),
        ...(input.campId ? { campId: input.campId } : {}),
        ...(mayExistOnServer ? { mayExistOnServer } : {}),
      };
      await this.tables.outbox.add(op);
    });
    this.notify();
  }

  /** Envoi d'un plan (et des fichiers qu'il référence, s'ils ne sont pas déjà envoyés). */
  async enqueuePlan(doc: PlanDocument, origin: SyncOperationRecord['origin'] = 'create') {
    const shas = planShas(doc);
    for (const sha of shas) await this.enqueueFile(sha, doc.plan.name);
    await this.enqueue({
      kind: 'plan.upsert',
      entityType: 'plan',
      entityId: doc.plan.id,
      label: doc.plan.name,
      dependsOn: [entityKey('camp', doc.plan.siteId), ...shas.map((s) => entityKey('file', s))],
      origin,
      planId: doc.plan.id,
      campId: doc.plan.siteId,
    });
  }

  async enqueueFile(sha: string, context: string) {
    if (await this.tables.syncLinks.get(entityKey('file', sha))) return;
    await this.enqueue({
      kind: 'file.upload',
      entityType: 'file',
      entityId: sha,
      label: `Fichier de « ${context} »`,
    });
  }

  list() {
    return this.tables.outbox.orderBy('seq').toArray();
  }

  async update(seq: number, patch: Partial<SyncOperationRecord>) {
    await this.tables.outbox.update(seq, patch);
  }

  async remove(seq: number) {
    await this.tables.outbox.delete(seq);
  }
}

/** Empreintes des fichiers d'un plan : photo (et PDF d'origine), pictogrammes, logo. */
export function planShas(doc: PlanDocument): string[] {
  const image = doc.plan.baseImage;
  const shas = image ? [image.sha256, ...(image.source.kind === 'pdf' ? [image.source.pdfSha256] : [])] : [];
  for (const asset of Object.values(doc.assets)) shas.push(asset.sha256);
  return [...new Set(shas)];
}
