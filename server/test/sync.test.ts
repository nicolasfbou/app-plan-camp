/**
 * Synchronisation de bout en bout : deux « ordinateurs » (bases locales distinctes) et le serveur
 * réel. Hors ligne, retour en ligne, conflits, serveur indisponible, envoi interrompu, double
 * envoi, suppression et révision hors ligne. Critère : AUCUNE donnée perdue, aucun écrasement
 * silencieux.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlanDocument, createSite } from '@/domain/model/factories.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { freezeRevision, isSealIntact } from '@/domain/revisions/revision.ts';
import { OnlineRequiredError } from '@/sync/syncingRepository.ts';
import { device } from './devices.ts';
import { createHarness, type Harness, jpeg, sha256 } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

type Device = Awaited<ReturnType<typeof device>>;

async function newLocalPlan(d: Device, name = 'Circulation') {
  const photo = jpeg(8192);
  const blob = await d.repo.putBlob(new Uint8Array(photo).buffer, 'image/jpeg');
  const site = createSite('Camp 105');
  await d.repo.saveSite(site);
  const doc = createPlanDocument({ siteId: site.id, name });
  doc.plan.baseImage = {
    blobId: blob.id,
    fileName: 'camp-105.jpg',
    mimeType: 'image/jpeg',
    byteLength: photo.length,
    sha256: blob.sha256,
    width: 400,
    height: 300,
    exifOrientation: 1,
    importedAt: new Date().toISOString(),
    source: { kind: 'image' },
  };
  await d.repo.savePlan(doc);
  return { doc, photo, site };
}

async function edit(d: Device, planId: string, notes: string) {
  const opened = (await d.repo.openPlan(planId))!;
  const doc: PlanDocument = structuredClone(opened.doc);
  doc.plan.titleBlock.notes = notes;
  await d.repo.savePlan(doc, { expectedVersion: opened.version });
}

const serverVersions = async (planId: string) =>
  (
    await h.db.owner.query('SELECT version FROM plan_versions WHERE plan_id = $1 ORDER BY version', [planId])
  ).rows.map((r) => Number(r.version));

describe('synchronisation hors ligne / en ligne', () => {
  it('publication, ouverture sur un second poste, photo identique (SHA-256)', async () => {
    const a = await device(h, 'gestion@pamm.test', h.orgA.id);
    const b = await device(h, 'edition@pamm.test', h.orgA.id);
    const { doc, photo } = await newLocalPlan(a);
    await a.sync();
    expect(await a.engine.outbox.list()).toHaveLength(0);
    expect(await serverVersions(doc.plan.id)).toEqual([1]);
    await b.sync();
    const onB = (await b.repo.openPlan(doc.plan.id))!;
    expect(onB.doc.plan.name).toBe('Circulation');
    const blob = (await b.repo.getBlob(onB.doc.plan.baseImage!.blobId))!;
    expect(sha256(Buffer.from(blob.bytes))).toBe(sha256(photo));
    // Aucun renvoi en écho : B n'a rien à envoyer.
    expect(await b.engine.outbox.list()).toHaveLength(0);
    a.close();
    b.close();
  });

  it('hors ligne : modifications conservées localement, regroupées, envoyées au retour ; rien de perdu', async () => {
    const a = await device(h, 'gestion@pamm.test', h.orgA.id);
    const { doc } = await newLocalPlan(a);
    await a.sync();
    a.net.online = false;
    for (let i = 1; i <= 5; i++) await edit(a, doc.plan.id, `hors ligne ${i}`);
    await a.sync();
    expect(a.engine.status.reachable).toBe(false);
    const ops = await a.engine.outbox.list();
    expect(ops.filter((o) => o.kind === 'plan.upsert')).toHaveLength(1); // regroupées
    expect(ops[0]).toMatchObject({
      entityType: 'plan',
      entityId: doc.plan.id,
      organizationId: h.orgA.id,
      status: 'pending',
    });
    expect(ops[0]!.retryCount).toBe(1);
    expect(ops[0]!.lastError).toMatch(/injoignable/);
    expect((await a.repo.openPlan(doc.plan.id))!.doc.plan.titleBlock.notes).toBe('hors ligne 5');
    a.net.online = true;
    await a.engine.outbox.update(ops[0]!.seq!, { nextAttemptAt: 0 });
    await a.sync();
    expect(await a.engine.outbox.list()).toHaveLength(0);
    expect(await serverVersions(doc.plan.id)).toEqual([1, 2]);
    const server = await h.db.owner.query(
      'SELECT document FROM plan_versions WHERE plan_id = $1 AND version = 2',
      [doc.plan.id],
    );
    expect(server.rows[0].document.plan.titleBlock.notes).toBe('hors ligne 5');
    a.close();
  });

  it('conflit entre deux ordinateurs : détecté, rien d’écrasé ; « garder ma version » garde aussi l’autre dans l’historique', async () => {
    const a = await device(h, 'gestion@pamm.test', h.orgA.id);
    const b = await device(h, 'edition@pamm.test', h.orgA.id);
    const { doc } = await newLocalPlan(a);
    await a.sync();
    await b.sync();
    a.net.online = false;
    await edit(a, doc.plan.id, 'version A (hors ligne)');
    await edit(b, doc.plan.id, 'version B (serveur)');
    await b.sync();
    a.net.online = true;
    await a.sync();
    const conflicts = await a.raw.sync.conflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      planId: doc.plan.id,
      reason: 'version',
      serverVersion: 2,
      serverUpdatedBy: 'N. Tremblay',
    });
    expect((conflicts[0]!.serverDoc as PlanDocument).plan.titleBlock.notes).toBe('version B (serveur)');
    // Rien d'écrasé : ni la copie locale de A, ni le serveur.
    expect((await a.repo.openPlan(doc.plan.id))!.doc.plan.titleBlock.notes).toBe('version A (hors ligne)');
    expect(await serverVersions(doc.plan.id)).toEqual([1, 2]);
    expect((await a.engine.outbox.list())[0]!.status).toBe('blocked');
    await a.engine.keepMine(doc.plan.id);
    await a.sync();
    expect(await serverVersions(doc.plan.id)).toEqual([1, 2, 3]);
    const v = await h.db.owner.query(
      'SELECT version, document FROM plan_versions WHERE plan_id = $1 ORDER BY version',
      [doc.plan.id],
    );
    expect(v.rows.map((r) => r.document.plan.titleBlock.notes)).toEqual([
      '',
      'version B (serveur)',
      'version A (hors ligne)',
    ]);
    a.close();
    b.close();
  });

  it('« garder la version serveur » : ma version est mise de côté (récupérable) ; « copie » : les deux versions restent', async () => {
    const a = await device(h, 'gestion@pamm.test', h.orgA.id);
    const b = await device(h, 'gestion@pamm.test', h.orgA.id);
    const { doc } = await newLocalPlan(a);
    await a.sync();
    await b.sync();
    a.net.online = false;
    await edit(a, doc.plan.id, 'A1');
    await edit(b, doc.plan.id, 'B1');
    await b.sync();
    a.net.online = true;
    await a.sync();
    await a.engine.keepServer(doc.plan.id);
    expect((await a.repo.openPlan(doc.plan.id))!.doc.plan.titleBlock.notes).toBe('B1');
    const archived = await a.raw.sync.conflictArchive.toArray();
    expect((archived[0]!.doc as PlanDocument).plan.titleBlock.notes).toBe('A1');

    // Deuxième conflit, résolu par une copie.
    a.net.online = false;
    await edit(a, doc.plan.id, 'A2');
    await edit(b, doc.plan.id, 'B2');
    await b.sync();
    a.net.online = true;
    await a.sync();
    const copyId = await a.engine.keepBothAsCopy(doc.plan.id, 'Circulation (ma version)');
    await a.sync();
    expect((await a.repo.openPlan(doc.plan.id))!.doc.plan.titleBlock.notes).toBe('B2');
    expect((await a.repo.openPlan(copyId))!.doc.plan.titleBlock.notes).toBe('A2');
    const onServer = await h.db.owner.query('SELECT id FROM plans WHERE id = ANY($1)', [
      [doc.plan.id, copyId],
    ]);
    expect(onServer.rows).toHaveLength(2);
    a.close();
    b.close();
  });

  it('serveur indisponible, envoi de photo interrompu, réponse perdue (double envoi) : aucune duplication', async () => {
    const a = await device(h, 'gestion@pamm.test', h.orgA.id);
    // Envoi de la photo coupé en plein vol.
    a.net.failNext = (m, u) => m === 'PUT' && u.startsWith('/api/files/');
    const { doc, photo } = await newLocalPlan(a);
    await a.sync();
    expect((await a.engine.outbox.list()).length).toBeGreaterThan(0);
    const files = await h.db.owner.query('SELECT count(*)::int AS n FROM files WHERE sha256 = $1', [
      sha256(photo),
    ]);
    expect(files.rows[0].n).toBe(0); // rien d'enregistré à moitié
    for (const op of await a.engine.outbox.list())
      await a.engine.outbox.update(op.seq!, { nextAttemptAt: 0 });
    // Réponse de l'envoi du plan perdue : le serveur a enregistré, le client ne le sait pas.
    a.net.loseNextResponse = (m, u) => m === 'PUT' && u.startsWith('/api/plans/');
    await a.sync();
    expect(await serverVersions(doc.plan.id)).toEqual([1]);
    for (const op of await a.engine.outbox.list())
      await a.engine.outbox.update(op.seq!, { nextAttemptAt: 0 });
    await a.sync(); // même opération rejouée (même identifiant) : réponse mémorisée
    expect(await a.engine.outbox.list()).toHaveLength(0);
    expect(await serverVersions(doc.plan.id)).toEqual([1]);
    const again = await h.db.owner.query('SELECT count(*)::int AS n FROM files WHERE sha256 = $1', [
      sha256(photo),
    ]);
    expect(again.rows[0].n).toBe(1);
    a.close();
  });

  it('suppression hors ligne : envoyée au retour (suppression logique), propagée à l’autre poste', async () => {
    const a = await device(h, 'gestion@pamm.test', h.orgA.id);
    const b = await device(h, 'edition@pamm.test', h.orgA.id);
    const { doc } = await newLocalPlan(a);
    await a.sync();
    await b.sync();
    a.net.online = false;
    await a.repo.deletePlan(doc.plan.id);
    await a.sync();
    expect((await a.engine.outbox.list()).map((o) => o.kind)).toEqual(['plan.delete']);
    a.net.online = true;
    for (const op of await a.engine.outbox.list())
      await a.engine.outbox.update(op.seq!, { nextAttemptAt: 0 });
    await a.sync();
    const row = await h.db.owner.query('SELECT deleted_at FROM plans WHERE id = $1', [doc.plan.id]);
    expect(row.rows[0].deleted_at).not.toBeNull(); // logique : l'historique reste sur le serveur
    await b.sync();
    expect(await b.repo.openPlan(doc.plan.id)).toBeUndefined();
    a.close();
    b.close();
  });

  it('révision créée hors ligne : envoyée au retour, reçue intacte ; approbation seulement en ligne, datée par le serveur', async () => {
    const a = await device(h, 'gestion@pamm.test', h.orgA.id);
    const b = await device(h, 'edition@pamm.test', h.orgA.id);
    const { doc } = await newLocalPlan(a);
    await a.sync();
    a.net.online = false;
    const rev = await freezeRevision(
      (await a.repo.openPlan(doc.plan.id))!.doc,
      {
        label: 'A',
        description: 'Émission',
        author: 'M. Gagnon',
        date: '2026-10-01',
        reason: '',
        comments: '',
        status: 'review',
      },
      {
        id: `rev-${doc.plan.id}`,
        existingLabels: [],
        parentId: null,
        changes: null,
        now: new Date().toISOString(),
      },
    );
    await a.repo.createRevision(rev);
    await expect(
      a.repo.setRevisionStatus(rev.meta.id, { to: 'approved', by: 'x', comment: '', confirmed: true }),
    ).rejects.toBeInstanceOf(OnlineRequiredError);
    a.net.online = true;
    for (const op of await a.engine.outbox.list())
      await a.engine.outbox.update(op.seq!, { nextAttemptAt: 0 });
    await a.sync();
    expect(await a.engine.outbox.list()).toHaveLength(0);
    const meta = await a.repo.setRevisionStatus(rev.meta.id, {
      to: 'approved',
      by: 'ignoré',
      comment: 'OK',
      confirmed: true,
    });
    expect(meta.approval).toMatchObject({
      by: 'M. Gagnon',
      verificationType: 'authenticated_server',
      approverUserId: h.users.managerA.id,
    });
    expect(await isSealIntact(meta)).toBe(true);
    await b.sync();
    const onB = (await b.repo.listRevisions(doc.plan.id))[0]!;
    expect(onB.sealIntact).toBe(true);
    expect(onB.meta!.approval!.verificationType).toBe('authenticated_server');
    a.close();
    b.close();
  });

  it('opération refusée par le serveur : visible avec son message, les opérations indépendantes continuent', async () => {
    const manager = await device(h, 'gestion@pamm.test', h.orgA.id);
    const { doc } = await newLocalPlan(manager);
    await manager.sync();
    const editor = await device(h, 'edition@pamm.test', h.orgA.id);
    await editor.sync();
    // L'éditeur crée un camp (interdit à son rôle) et modifie un plan existant (permis).
    await editor.repo.saveSite(createSite('Camp interdit'));
    await edit(editor, doc.plan.id, 'modifié par l’éditeur');
    await editor.sync();
    const ops = await editor.engine.outbox.list();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'camp.upsert', status: 'failed' });
    expect(ops[0]!.lastError).toMatch(/rôle/);
    expect(await serverVersions(doc.plan.id)).toEqual([1, 2]);
    manager.close();
    editor.close();
  });
});
