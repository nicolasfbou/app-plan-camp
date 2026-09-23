/**
 * Moteur de synchronisation d'un espace d'organisation (un seul onglet l'exécute : verrou Web
 * Locks). Il n'écrit JAMAIS par-dessus une copie locale qui a des changements non envoyés :
 * dans ce cas, c'est un conflit, décidé par l'utilisateur.
 *
 * 1. Envoi : opérations de la file dans l'ordre, chacune seulement quand celles dont elle dépend
 *    sont passées ; erreurs réseau → nouvel essai plus tard (délai croissant) ; refus du serveur →
 *    opération « en échec » visible, avec son message ; version périmée → conflit.
 * 2. Réception : changements de l'organisation depuis le curseur ; un plan ouvert en édition
 *    n'est pas remplacé sous l'éditeur (mise à jour proposée, appliquée à la demande).
 */
import { newId, nowIso, duplicatePlanDocument } from '@/domain/model/factories.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { revisionMetaSchema, type RevisionMeta } from '@/domain/revisions/revision.ts';
import { parsePlanDocument } from '@/domain/schema/serialization.ts';
import { sha256Hex } from '@/domain/image/hash.ts';
import { templateSchema } from '@/domain/templates/template.ts';
import type { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import { type Api, ApiError, type Change, type ServerPlan, type ServerRevision } from './api.ts';
import { Outbox, planShas } from './outbox.ts';
import {
  entityKey,
  type SyncConflictRecord,
  type SyncLinkRecord,
  type SyncOperationRecord,
} from './types.ts';

export interface EngineStatus {
  reachable: boolean;
  authRequired: boolean;
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface SyncMessage {
  type: 'server-updated' | 'pull-applied' | 'status' | 'kick' | 'apply-pull';
  planId?: string;
  status?: EngineStatus;
  /** Relance demandée explicitement (retour du réseau, « Synchroniser maintenant ») : sans délai. */
  force?: boolean;
}

export interface EngineDeps {
  /** Dépôt SANS mise en file (les écritures reçues du serveur ne repartent pas vers lui). */
  raw: IndexedDbRepository;
  api: Api;
  orgId: string;
  /** Plans ouverts en édition dans un onglet (jamais remplacés sous l'éditeur). */
  openPlanIds?: () => Promise<Set<string>>;
  post?: (message: SyncMessage) => void;
  now?: () => number;
}

const MAX_BACKOFF_MS = 5 * 60_000;
const backoff = (retry: number) => Math.min(MAX_BACKOFF_MS, 2000 * 2 ** Math.min(retry, 8));

export class SyncEngine {
  readonly outbox: Outbox;
  status: EngineStatus = {
    reachable: true,
    authRequired: false,
    syncing: false,
    lastSyncAt: null,
    lastError: null,
  };
  private running: Promise<void> | null = null;

  constructor(private readonly deps: EngineDeps) {
    this.outbox = new Outbox(deps.raw.sync, deps.orgId);
  }

  private get t() {
    return this.deps.raw.sync;
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private post(message: SyncMessage) {
    this.deps.post?.(message);
  }
  private setStatus(patch: Partial<EngineStatus>) {
    this.status = { ...this.status, ...patch };
    this.post({ type: 'status', status: this.status });
  }

  /** Un cycle complet (envoi puis réception). Jamais deux cycles en même temps. */
  runOnce(): Promise<void> {
    this.running ??= (async () => {
      this.setStatus({ syncing: true });
      try {
        await this.push();
        if (this.status.reachable && !this.status.authRequired) {
          await this.pull();
          await this.applyDeferredPulls();
          this.setStatus({ lastSyncAt: new Date(this.now()).toISOString(), lastError: null });
        }
      } catch (error) {
        this.handleTransport(error);
      } finally {
        this.setStatus({ syncing: false });
        this.running = null;
      }
    })();
    return this.running;
  }

  private handleTransport(error: unknown) {
    if (error instanceof ApiError && error.network)
      this.setStatus({ reachable: false, lastError: error.message });
    else if (error instanceof ApiError && error.status === 401)
      this.setStatus({
        authRequired: true,
        lastError: 'Session expirée : reconnectez-vous pour synchroniser.',
      });
    else this.setStatus({ lastError: error instanceof Error ? error.message : String(error) });
  }

  // --- Envoi ---------------------------------------------------------------------------------

  async push(): Promise<void> {
    const ops = await this.outbox.list();
    const waiting = new Set<string>();
    for (const op of ops) {
      const own = op.keys[0]!;
      if (op.status === 'done') continue;
      if (op.keys.some((k) => waiting.has(k)) || op.status !== 'pending' || op.nextAttemptAt > this.now()) {
        waiting.add(own);
        continue;
      }
      try {
        const outcome = await this.execute(op);
        if (outcome === 'done') await this.outbox.remove(op.seq!);
        else waiting.add(own);
        this.setStatus({ reachable: true, authRequired: false });
      } catch (error) {
        waiting.add(own);
        if (error instanceof ApiError && error.network) {
          await this.outbox.update(op.seq!, {
            retryCount: op.retryCount + 1,
            nextAttemptAt: this.now() + backoff(op.retryCount),
            lastError: 'Serveur injoignable : nouvel essai automatique.',
          });
          this.setStatus({ reachable: false, lastError: error.message });
          return; // inutile d'essayer les suivantes maintenant
        }
        if (error instanceof ApiError && error.status === 401) {
          this.setStatus({
            authRequired: true,
            lastError: 'Session expirée : reconnectez-vous pour synchroniser.',
          });
          return;
        }
        // Refus du serveur (droits, validation) : visible, jamais retiré sans action.
        await this.outbox.update(op.seq!, {
          status: 'failed',
          retryCount: op.retryCount + 1,
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async link(type: SyncLinkRecord['entityType'], id: string) {
    return this.t.syncLinks.get(entityKey(type, id));
  }
  private async setLink(link: Omit<SyncLinkRecord, 'key' | 'syncedAt'> & Partial<SyncLinkRecord>) {
    const key = entityKey(link.entityType, link.entityId);
    const current = await this.t.syncLinks.get(key);
    await this.t.syncLinks.put({ ...current, ...link, key, syncedAt: nowIso() } as SyncLinkRecord);
  }

  /** `done` : opération terminée (retirée) ; `wait` : bloquée (conflit) ou reportée. */
  private async execute(op: SyncOperationRecord): Promise<'done' | 'wait'> {
    const headers = (ifMatch: number) => ({ 'If-Match': String(ifMatch), 'Idempotency-Key': op.operationId });
    const enc = encodeURIComponent;
    switch (op.kind) {
      case 'file.upload': {
        const blobId = await this.deps.raw.findBlobBySha256(op.entityId);
        const blob = blobId ? await this.deps.raw.getBlob(blobId) : undefined;
        if (!blob) throw new Error('Fichier absent de cet appareil : impossible de l’envoyer.');
        await this.deps.api.request('PUT', `/api/files/${op.entityId}`, {
          raw: new Uint8Array(blob.bytes),
          headers: { 'X-File-Type': blob.mimeType },
        });
        await this.setLink({ entityType: 'file', entityId: op.entityId, serverVersion: 1 });
        return 'done';
      }
      case 'camp.upsert': {
        const site = await this.deps.raw.getSite(op.entityId);
        if (!site) return 'done'; // supprimé depuis : la suppression suit
        const link = await this.link('camp', site.id);
        const r = await this.deps.api.request<{ serverVersion: number }>(
          'PUT',
          `/api/camps/${enc(site.id)}`,
          {
            body: { name: site.name, notes: site.notes },
            headers: headers(link?.serverVersion ?? 0),
          },
        );
        await this.setLink({ entityType: 'camp', entityId: site.id, serverVersion: r.serverVersion });
        return 'done';
      }
      case 'camp.delete': {
        const link = await this.link('camp', op.entityId);
        if (!link) return 'done';
        try {
          await this.deps.api.request('DELETE', `/api/camps/${enc(op.entityId)}`, {
            headers: headers(link.serverVersion),
          });
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        await this.setLink({
          entityType: 'camp',
          entityId: op.entityId,
          serverVersion: link.serverVersion + 1,
          deleted: true,
        });
        return 'done';
      }
      case 'plan.upsert':
        return this.pushPlan(op);
      case 'plan.delete': {
        const link = await this.link('plan', op.entityId);
        if (!link) return 'done';
        try {
          const r = await this.deps.api.request<{ serverVersion: number }>(
            'DELETE',
            `/api/plans/${enc(op.entityId)}`,
            {
              headers: headers(link.serverVersion),
            },
          );
          await this.setLink({
            entityType: 'plan',
            entityId: op.entityId,
            serverVersion: r.serverVersion,
            deleted: true,
          });
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return 'done';
          if (error instanceof ApiError && error.status === 409)
            throw new Error(
              'Plan modifié sur le serveur depuis votre dernière synchronisation : suppression NON envoyée. « Réessayer » le supprimera quand même ; « Abandonner » le récupérera depuis le serveur.',
              { cause: error },
            );
          throw error;
        }
        return 'done';
      }
      case 'revision.create':
        return this.pushRevision(op);
      case 'revision.delete':
        try {
          await this.deps.api.request('DELETE', `/api/revisions/${enc(op.entityId)}`);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        return 'done';
      case 'template.upsert': {
        const entry = await this.deps.raw.getTemplate(op.entityId);
        if (!entry) return 'done';
        if (entry.template.logo && entry.logo) {
          await this.deps.api.request('PUT', `/api/files/${entry.template.logo.sha256}`, {
            raw: entry.logo,
            headers: { 'X-File-Type': entry.template.logo.mimeType },
          });
        }
        const link = await this.link('template', op.entityId);
        const r = await this.deps.api.request<{ serverVersion: number }>(
          'PUT',
          `/api/templates/${enc(op.entityId)}`,
          {
            body: { template: entry.template },
            headers: headers(link?.serverVersion ?? 0),
          },
        );
        await this.setLink({ entityType: 'template', entityId: op.entityId, serverVersion: r.serverVersion });
        return 'done';
      }
      case 'template.delete': {
        const link = await this.link('template', op.entityId);
        if (!link) return 'done';
        try {
          await this.deps.api.request('DELETE', `/api/templates/${enc(op.entityId)}`);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        return 'done';
      }
    }
  }

  private async ensureFiles(doc: PlanDocument) {
    for (const sha of planShas(doc)) {
      if (await this.link('file', sha)) continue;
      const present = await this.deps.api.request<{ present: string[] }>('POST', '/api/files/check', {
        body: { sha256: [sha] },
      });
      if (!present.present.includes(sha))
        await this.execute({
          operationId: `op-file-${sha.slice(0, 16)}`,
          kind: 'file.upload',
          entityType: 'file',
          entityId: sha,
        } as SyncOperationRecord);
      else await this.setLink({ entityType: 'file', entityId: sha, serverVersion: 1 });
    }
  }

  private async pushPlan(op: SyncOperationRecord): Promise<'done' | 'wait'> {
    if (await this.t.conflicts.get(op.entityId)) {
      await this.outbox.update(op.seq!, {
        status: 'blocked',
        lastError: 'Conflit à résoudre avant l’envoi.',
      });
      return 'wait';
    }
    const local = await this.deps.raw.openPlan(op.entityId);
    if (!local) return 'done'; // supprimé localement : l'opération de suppression suit
    await this.ensureFiles(local.doc);
    const link = await this.link('plan', op.entityId);
    try {
      const r = await this.deps.api.request<{ serverVersion: number }>(
        'PUT',
        `/api/plans/${encodeURIComponent(op.entityId)}`,
        {
          body: { campId: local.doc.plan.siteId, document: local.doc, origin: op.origin ?? 'create' },
          headers: { 'If-Match': String(link?.serverVersion ?? 0), 'Idempotency-Key': op.operationId },
        },
      );
      await this.setLink({
        entityType: 'plan',
        entityId: op.entityId,
        serverVersion: r.serverVersion,
        syncedLocalVersion: local.version,
        baseDoc: local.doc,
        deleted: false,
      });
      // Modifié localement PENDANT l'envoi : un nouvel envoi est mis en file (rien de perdu).
      const after = await this.deps.raw.getPlanVersion(op.entityId);
      if (after !== undefined && after !== local.version) {
        await this.outbox.remove(op.seq!);
        const latest = await this.deps.raw.openPlan(op.entityId);
        if (latest) await this.outbox.enqueuePlan(latest.doc);
        return 'wait';
      }
      return 'done';
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && ['version', 'deleted'].includes(error.code)) {
        await this.recordConflict(op, local, error.code as 'version' | 'deleted', link);
        return 'wait';
      }
      if (error instanceof ApiError && error.code === 'missing-files') {
        // Un fichier a manqué (course) : liens oubliés, nouvel essai au prochain cycle.
        for (const sha of (error.body.missing as string[] | undefined) ?? [])
          await this.t.syncLinks.delete(entityKey('file', sha));
        throw new ApiError(0, 'network', 'Fichiers en cours d’envoi.');
      }
      throw error;
    }
  }

  private async recordConflict(
    op: SyncOperationRecord,
    local: { doc: PlanDocument; version: number },
    reason: 'version' | 'deleted',
    link: SyncLinkRecord | undefined,
  ) {
    let server: ServerPlan | null = null;
    try {
      server = await this.deps.api.request<ServerPlan>(
        'GET',
        `/api/plans/${encodeURIComponent(op.entityId)}`,
      );
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    const conflict: SyncConflictRecord = {
      planId: op.entityId,
      planName: local.doc.plan.name,
      reason: server?.deleted || !server ? 'deleted' : reason,
      serverVersion: server?.serverVersion ?? 0,
      serverDoc: server && !server.deleted ? server.document : null,
      serverUpdatedBy: server?.updatedBy ?? '',
      serverUpdatedAt: server?.updatedAt ?? '',
      localVersion: local.version,
      localUpdatedAt: local.doc.plan.updatedAt,
      baseDoc: link?.baseDoc ?? null,
      detectedAt: nowIso(),
      operationId: op.operationId,
    };
    await this.t.conflicts.put(conflict);
    await this.outbox.update(op.seq!, {
      status: 'blocked',
      lastError:
        conflict.reason === 'deleted'
          ? 'Plan supprimé sur le serveur : à décider.'
          : `Plan modifié sur le serveur par ${conflict.serverUpdatedBy || 'un autre poste'} : à décider.`,
    });
    this.post({ type: 'server-updated', planId: op.entityId });
  }

  private async pushRevision(op: SyncOperationRecord): Promise<'done' | 'wait'> {
    let loaded: { meta: RevisionMeta; json: string };
    try {
      const r = await this.deps.raw.loadRevision(op.entityId);
      const snap = await this.deps.raw.readRevisionSnapshot(op.entityId);
      loaded = { meta: r.meta, json: snap.json };
    } catch {
      return 'done'; // supprimée localement depuis
    }
    await this.ensureFiles(parsePlanDocument(loaded.json));
    await this.deps.api.request('PUT', `/api/revisions/${encodeURIComponent(op.entityId)}`, {
      body: { planId: loaded.meta.planId, meta: loaded.meta, snapshot: loaded.json },
    });
    await this.setLink({
      entityType: 'revision',
      entityId: op.entityId,
      serverVersion: loaded.meta.statusLog.length,
    });
    return 'done';
  }

  // --- Réception -----------------------------------------------------------------------------

  async pull(): Promise<void> {
    let cursor = ((await this.t.syncState.get('cursor'))?.value as number | undefined) ?? 0;
    for (let page = 0; page < 50; page++) {
      const r = await this.deps.api.request<{ changes: Change[]; cursor: number; more: boolean }>(
        'GET',
        `/api/sync/changes?since=${cursor}&limit=500`,
      );
      // Dernier état par élément (plusieurs changements d'un même plan = une seule lecture).
      const latest = new Map<string, Change>();
      for (const c of r.changes) latest.set(`${c.kind}:${c.id}`, c);
      const ordered = [...latest.values()].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.seq - b.seq);
      let camps: Map<
        string,
        { id: string; name: string; notes: string; createdAt: string; updatedAt: string }
      > | null = null;
      for (const change of ordered) {
        if (change.kind === 'camp') {
          camps ??= new Map(
            (
              await this.deps.api.request<{
                camps: { id: string; name: string; notes: string; createdAt: string; updatedAt: string }[];
              }>('GET', '/api/camps')
            ).camps.map((c) => [c.id, c]),
          );
          await this.pullCamp(change, camps.get(change.id));
        } else if (change.kind === 'plan') await this.pullPlan(change);
        else if (change.kind === 'revision') await this.pullRevision(change);
        else await this.pullTemplate(change);
      }
      cursor = r.cursor;
      await this.t.syncState.put({ key: 'cursor', value: cursor });
      // Listes à relire (camps, plans reçus) dans tous les onglets.
      if (ordered.length) this.post({ type: 'pull-applied' });
      if (!r.more) break;
    }
  }

  private async pullCamp(
    change: Change,
    camp: { id: string; name: string; notes: string; createdAt: string; updatedAt: string } | undefined,
  ) {
    const link = await this.link('camp', change.id);
    if (link && change.serverVersion <= link.serverVersion) return;
    const pending = (await this.outbox.list()).some(
      (o) => o.entityId === change.id && o.entityType === 'camp',
    );
    if (change.deleted) {
      const plans = await this.deps.raw.listPlans(change.id);
      if (!plans.length && !pending) await this.deps.raw.deleteSite(change.id);
    } else if (camp && !pending) {
      const local = await this.deps.raw.getSite(change.id);
      await this.deps.raw.saveSite({
        id: camp.id,
        name: camp.name,
        notes: camp.notes,
        createdAt: local?.createdAt ?? camp.createdAt,
        updatedAt: camp.updatedAt,
      });
    }
    await this.setLink({
      entityType: 'camp',
      entityId: change.id,
      serverVersion: change.serverVersion,
      deleted: change.deleted,
    });
  }

  /** Changements locaux non envoyés pour ce plan ? */
  private async locallyDirty(planId: string, link: SyncLinkRecord | undefined) {
    const pending = (await this.outbox.list()).some((o) => o.planId === planId && o.entityType === 'plan');
    if (pending) return true;
    const version = await this.deps.raw.getPlanVersion(planId);
    if (version === undefined) return false;
    return !link || link.syncedLocalVersion !== version;
  }

  private async pullPlan(change: Change) {
    const link = await this.link('plan', change.id);
    if (link && change.serverVersion <= link.serverVersion && !link.pendingPull) return;
    if (await this.t.conflicts.get(change.id)) return; // décision en attente : rien n'est touché
    const dirty = await this.locallyDirty(change.id, link);
    if (change.deleted) {
      if (dirty) {
        const local = await this.deps.raw.openPlan(change.id);
        if (local) await this.saveConflict(change.id, local, 'deleted', null, link);
        return;
      }
      await this.deps.raw.deletePlan(change.id);
      await this.setLink({
        entityType: 'plan',
        entityId: change.id,
        serverVersion: change.serverVersion,
        deleted: true,
      });
      return;
    }
    if (dirty) {
      const local = await this.deps.raw.openPlan(change.id);
      if (!local) return; // suppression locale en attente : décidée à l'envoi
      const server = await this.deps.api.request<ServerPlan>(
        'GET',
        `/api/plans/${encodeURIComponent(change.id)}`,
      );
      await this.saveConflict(change.id, local, 'version', server, link);
      return;
    }
    if ((await this.deps.openPlanIds?.())?.has(change.id)) {
      // Ouvert en édition : jamais remplacé sous l'éditeur ; mise à jour proposée.
      await this.setLink({
        ...(link ?? { entityType: 'plan', entityId: change.id, serverVersion: 0 }),
        pendingPull: change.serverVersion,
      });
      this.post({ type: 'server-updated', planId: change.id });
      return;
    }
    await this.applyServerPlan(change.id);
  }

  private async saveConflict(
    planId: string,
    local: { doc: PlanDocument; version: number },
    reason: 'version' | 'deleted',
    server: ServerPlan | null,
    link: SyncLinkRecord | undefined,
  ) {
    await this.t.conflicts.put({
      planId,
      planName: local.doc.plan.name,
      reason,
      serverVersion: server?.serverVersion ?? 0,
      serverDoc: server?.document ?? null,
      serverUpdatedBy: server?.updatedBy ?? '',
      serverUpdatedAt: server?.updatedAt ?? '',
      localVersion: local.version,
      localUpdatedAt: local.doc.plan.updatedAt,
      baseDoc: link?.baseDoc ?? null,
      detectedAt: nowIso(),
      operationId: '',
    });
    for (const op of await this.outbox.list())
      if (op.planId === planId && op.entityType === 'plan' && op.status === 'pending')
        await this.outbox.update(op.seq!, {
          status: 'blocked',
          lastError: 'Conflit à résoudre avant l’envoi.',
        });
    this.post({ type: 'server-updated', planId });
  }

  /** Télécharge un plan serveur (et ses fichiers manquants) et l'écrit localement. */
  async applyServerPlan(planId: string): Promise<void> {
    const server = await this.deps.api.request<ServerPlan>('GET', `/api/plans/${encodeURIComponent(planId)}`);
    const doc = await this.localize(parsePlanDocument(server.document));
    if (!(await this.deps.raw.getSite(doc.plan.siteId))) {
      const camps = (
        await this.deps.api.request<{
          camps: { id: string; name: string; notes: string; createdAt: string; updatedAt: string }[];
        }>('GET', '/api/camps')
      ).camps;
      const camp = camps.find((c) => c.id === doc.plan.siteId);
      await this.deps.raw.saveSite({
        id: doc.plan.siteId,
        name: camp?.name ?? 'Camp',
        notes: camp?.notes ?? '',
        createdAt: camp?.createdAt ?? nowIso(),
        updatedAt: camp?.updatedAt ?? nowIso(),
      });
    }
    const current = await this.deps.raw.getPlanVersion(planId);
    const version = await this.deps.raw.savePlan(doc, { expectedVersion: current ?? 0 });
    await this.setLink({
      entityType: 'plan',
      entityId: planId,
      serverVersion: server.serverVersion,
      syncedLocalVersion: version,
      baseDoc: doc,
      pendingPull: undefined,
      deleted: false,
    });
    this.post({ type: 'pull-applied', planId });
  }

  /** Mises à jour reportées (plan ouvert) : appliquées dès que le plan n'est plus ouvert. */
  async applyDeferredPulls(force: string | null = null) {
    const links = await this.t.syncLinks.where('entityType').equals('plan').toArray();
    const open = (await this.deps.openPlanIds?.()) ?? new Set<string>();
    for (const link of links) {
      if (!link.pendingPull) continue;
      if (open.has(link.entityId) && force !== link.entityId) continue;
      if (await this.t.conflicts.get(link.entityId)) continue;
      if (await this.locallyDirty(link.entityId, link)) continue;
      await this.applyServerPlan(link.entityId);
    }
  }

  /** Identifiants locaux des fichiers (résolus par SHA-256, téléchargés s'ils manquent). */
  async localize(doc: PlanDocument): Promise<PlanDocument> {
    const local = async (sha: string, mimeType: string) => {
      const existing = await this.deps.raw.findBlobBySha256(sha);
      if (existing) return existing;
      const bytes = await this.deps.api.bytes(`/api/files/${sha}`);
      if ((await sha256Hex(bytes)) !== sha)
        throw new Error('Fichier reçu altéré (SHA-256 différent) : refusé.');
      return (await this.deps.raw.putBlob(bytes, mimeType)).id;
    };
    const next = structuredClone(doc);
    const image = next.plan.baseImage;
    if (image) {
      image.blobId = await local(image.sha256, image.mimeType);
      if (image.source.kind === 'pdf')
        image.source.pdfBlobId = await local(image.source.pdfSha256, 'application/pdf');
    }
    for (const asset of Object.values(next.assets)) asset.blobId = await local(asset.sha256, asset.mimeType);
    return next;
  }

  private async pullRevision(change: Change) {
    const server = await this.deps.api
      .request<ServerRevision>('GET', `/api/revisions/${encodeURIComponent(change.id)}`)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      });
    if (!server) return;
    const meta = revisionMetaSchema.parse(server.meta);
    const localEntry = (await this.deps.raw.listRevisions(meta.planId)).find((e) => e.id === meta.id);
    if (server.deleted) {
      if (localEntry) await this.deps.raw.deleteRevision(meta.id).catch(() => undefined);
    } else if (!localEntry) {
      if (!(await this.deps.raw.getPlanVersion(meta.planId))) return; // plan pas encore reçu
      const snapshot = parsePlanDocument(server.snapshot ?? '');
      const localized = await this.localize(snapshot);
      const blobMap: Record<string, string> = {};
      const pairs = (d: PlanDocument) => [
        ...(d.plan.baseImage
          ? [
              d.plan.baseImage.blobId,
              ...(d.plan.baseImage.source.kind === 'pdf' ? [d.plan.baseImage.source.pdfBlobId] : []),
            ]
          : []),
        ...Object.values(d.assets).map((a) => a.blobId),
      ];
      const from = pairs(snapshot);
      const to = pairs(localized);
      from.forEach((id, i) => (blobMap[id] = to[i]!));
      await this.deps.raw.importRevision({ meta, json: server.snapshot!, blobMap });
    } else if (localEntry.meta?.seal !== meta.seal) {
      await this.deps.raw.replaceRevisionMeta(meta.id, meta);
    }
    await this.setLink({ entityType: 'revision', entityId: meta.id, serverVersion: change.serverVersion });
  }

  private async pullTemplate(change: Change) {
    const pending = (await this.outbox.list()).some(
      (o) => o.entityId === change.id && o.entityType === 'template',
    );
    if (pending) return;
    if (change.deleted) {
      await this.deps.raw.deleteTemplate(change.id);
    } else {
      const list = await this.deps.api.request<{ templates: { id: string; template: unknown }[] }>(
        'GET',
        '/api/templates',
      );
      const found = list.templates.find((t) => t.id === change.id);
      if (!found) return;
      const template = templateSchema.parse(found.template);
      const logo = template.logo
        ? new Uint8Array(await this.deps.api.bytes(`/api/files/${template.logo.sha256}`))
        : null;
      await this.deps.raw.saveTemplate({ template, logo });
    }
    await this.setLink({ entityType: 'template', entityId: change.id, serverVersion: change.serverVersion });
  }

  // --- Résolution des conflits (choix explicites de l'utilisateur) --------------------------

  private async conflictOf(planId: string) {
    const c = await this.t.conflicts.get(planId);
    if (!c) throw new Error('Aucun conflit pour ce plan.');
    return c;
  }

  private async dropPlanOps(planId: string) {
    for (const op of await this.outbox.list())
      if (op.entityType === 'plan' && op.entityId === planId) await this.outbox.remove(op.seq!);
  }

  /** Garder la version serveur : ma version est d'abord mise de côté (récupérable), puis remplacée. */
  async keepServer(planId: string): Promise<void> {
    const conflict = await this.conflictOf(planId);
    const local = await this.deps.raw.openPlan(planId);
    if (local)
      await this.t.conflictArchive.add({
        planId,
        planName: local.doc.plan.name,
        doc: local.doc,
        archivedAt: nowIso(),
        reason: 'Version locale mise de côté (choix : garder la version serveur)',
      });
    await this.dropPlanOps(planId);
    await this.t.conflicts.delete(planId);
    if (conflict.reason === 'deleted') {
      if (local) await this.deps.raw.deletePlan(planId);
      await this.setLink({
        entityType: 'plan',
        entityId: planId,
        serverVersion: conflict.serverVersion,
        deleted: true,
      });
      this.post({ type: 'pull-applied', planId });
      return;
    }
    await this.applyServerPlan(planId);
  }

  /** Enregistrer ma version comme nouveau brouillon : envoyée PAR-DESSUS la version serveur (qui reste dans l'historique). */
  async keepMine(planId: string): Promise<void> {
    const conflict = await this.conflictOf(planId);
    if (conflict.reason === 'deleted')
      throw new Error('Ce plan a été supprimé sur le serveur : enregistrez votre version dans une copie.');
    const serverDoc = conflict.serverDoc
      ? await this.localize(parsePlanDocument(conflict.serverDoc))
      : undefined;
    await this.setLink({
      entityType: 'plan',
      entityId: planId,
      serverVersion: conflict.serverVersion,
      baseDoc: serverDoc,
      pendingPull: undefined,
    });
    await this.dropPlanOps(planId);
    await this.t.conflicts.delete(planId);
    const local = await this.deps.raw.openPlan(planId);
    if (local) await this.outbox.enqueuePlan(local.doc);
  }

  /** Créer une copie : ma version devient un nouveau plan ; l'original prend la version serveur. */
  async keepBothAsCopy(planId: string, copyName: string): Promise<string> {
    const local = await this.deps.raw.openPlan(planId);
    if (!local) throw new Error('Version locale introuvable.');
    const copy = duplicatePlanDocument(local.doc, copyName);
    await this.deps.raw.savePlan(copy);
    await this.outbox.enqueuePlan(copy);
    await this.dropPlanOps(planId);
    const conflict = await this.conflictOf(planId);
    await this.t.conflicts.delete(planId);
    if (conflict.reason === 'deleted') {
      await this.deps.raw.deletePlan(planId);
      await this.setLink({
        entityType: 'plan',
        entityId: planId,
        serverVersion: conflict.serverVersion,
        deleted: true,
      });
      this.post({ type: 'pull-applied', planId });
    } else await this.applyServerPlan(planId);
    return copy.plan.id;
  }

  /** Réseau revenu ou demande explicite : les opérations en attente de nouvel essai repartent tout de suite. */
  async resetBackoff() {
    for (const op of await this.outbox.list())
      if (op.status === 'pending' && op.nextAttemptAt > 0)
        await this.outbox.update(op.seq!, { nextAttemptAt: 0 });
    this.setStatus({ reachable: true });
  }

  /** Opération en échec : nouvel essai demandé explicitement. */
  async retry(seq: number) {
    await this.outbox.update(seq, { status: 'pending', nextAttemptAt: 0, lastError: null });
  }

  /** Abandon explicite d'une opération (la donnée locale reste sur l'appareil). */
  async abandon(seq: number) {
    const op = (await this.outbox.list()).find((o) => o.seq === seq);
    await this.outbox.remove(seq);
    // Suppression abandonnée : le plan redeviendra celui du serveur au prochain cycle.
    if (op?.kind === 'plan.delete') {
      const link = await this.link('plan', op.entityId);
      if (link) await this.setLink({ ...link, serverVersion: 0 });
    }
  }
}

const ORDER: Record<Change['kind'], number> = { camp: 0, template: 1, plan: 2, revision: 3 };

/** Nom d'une copie de conflit. */
export const conflictCopyName = (name: string) =>
  `${name} (ma version — conflit du ${nowIso().slice(0, 16).replace('T', ' ')})`;

export const newOperationId = () => `op-${newId()}-${newId()}`;
