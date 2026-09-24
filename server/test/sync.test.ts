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

describe('revue indépendante : aucune perte silencieuse', () => {
  const ready = async (d: Device) => {
    for (const op of await d.engine.outbox.list())
      await d.engine.outbox.update(op.seq!, { nextAttemptAt: 0 });
  };

  it('réponse perdue PUIS nouvelles modifications : le serveur reçoit bien la dernière version', async () => {
    const a = await device(h, 'gestion@pamm.test', h.orgA.id);
    const b = await device(h, 'edition@pamm.test', h.orgA.id);
    const { doc } = await newLocalPlan(a);
    await a.sync();
    await edit(a, doc.plan.id, 'modif 1');
    a.net.loseNextResponse = (m, u) => m === 'PUT' && u.startsWith('/api/plans/');
    await a.sync(); // le serveur a enregistré « modif 1 », l'appareil ne le sait pas
    await edit(a, doc.plan.id, 'modif 2'); // même opération en file (regroupement)
    await ready(a);
    await a.sync();
    expect(await a.engine.outbox.list()).toHaveLength(0);
    expect(await serverVersions(doc.plan.id)).toEqual([1, 2, 3]);
    const server = await h.db.owner.query(
      'SELECT document FROM plan_versions WHERE plan_id = $1 ORDER BY version DESC LIMIT 1',
      [doc.plan.id],
    );
    expect(server.rows[0].document.plan.titleBlock.notes).toBe('modif 2');
    // Un changement de l'autre poste arrive ensuite : reçu normalement, rien d'écrasé.
    await b.sync();
    await edit(b, doc.plan.id, 'poste 2');
    await b.sync();
    await a.sync();
    expect((await a.repo.openPlan(doc.plan.id))!.doc.plan.titleBlock.notes).toBe('poste 2');
    a.close();
    b.close();
  });

  it('plan supprimé pendant que sa création était en vol (réponse perdue) : supprimé aussi sur le serveur', async () => {
    const a = await device(h, 'gestion@pamm.test', h.orgA.id);
    const { doc } = await newLocalPlan(a);
    a.net.loseNextResponse = (m, u) => m === 'PUT' && u.startsWith('/api/plans/');
    await a.sync();
    expect(await serverVersions(doc.plan.id)).toEqual([1]);
    await a.repo.deletePlan(doc.plan.id);
    expect((await a.engine.outbox.list()).map((o) => o.kind)).toContain('plan.delete');
    await ready(a);
    await a.sync();
    const row = await h.db.owner.query('SELECT deleted_at FROM plans WHERE id = $1', [doc.plan.id]);
    expect(row.rows[0].deleted_at).not.toBeNull();
    a.close();
  });

  it('camp renommé des deux côtés : refus visible (jamais d’écrasement) ; « Abandonner » reprend le serveur', async () => {
    const a = await device(h, 'gestion@pamm.test', h.orgA.id);
    const b = await device(h, 'admin@pamm.test', h.orgA.id);
    const { site } = await newLocalPlan(a);
    await a.sync();
    await b.sync();
    a.net.online = false;
    await a.repo.saveSite({ ...(await a.repo.getSite(site.id))!, name: 'Nom du poste 1' });
    await b.repo.saveSite({ ...(await b.repo.getSite(site.id))!, name: 'Nom du poste 2' });
    await b.sync();
    a.net.online = true;
    await ready(a);
    await a.sync();
    const camp = await h.db.owner.query('SELECT name FROM camps WHERE id = $1', [site.id]);
    expect(camp.rows[0].name).toBe('Nom du poste 2');
    const failed = (await a.engine.outbox.list()).find((o) => o.kind === 'camp.upsert')!;
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toMatch(/modifié sur le serveur/);
    await a.engine.abandon(failed.seq!);
    expect((await a.repo.getSite(site.id))!.name).toBe('Nom du poste 2');
    a.close();
    b.close();
  });
});

describe('stabilité : relance pendant un cycle en cours', () => {
  it('retour du réseau PENDANT un envoi en échec : la relance n’est pas perdue, l’envoi repart aussitôt', async () => {
    const a = await device(h, 'gestion@pamm.test', h.orgA.id);
    const { doc } = await newLocalPlan(a);
    await a.sync();
    // Long hors ligne : plusieurs échecs, délai d'attente devenu long (32 s).
    a.net.online = false;
    await edit(a, doc.plan.id, 'hors ligne longtemps');
    const [op] = await a.engine.outbox.list();
    await a.engine.outbox.update(op!.seq!, { retryCount: 4, nextAttemptAt: 0 });
    // Un cycle démarre encore hors ligne : sa requête est « en vol » quand le réseau revient.
    let release!: (ok: boolean) => void;
    const inFlight = new Promise<void>((resolve, reject) => (release = (ok) => (ok ? resolve() : reject())));
    inFlight.catch(() => undefined);
    a.net.beforeRequest = (m, u) => (m === 'PUT' && u.startsWith('/api/plans/') ? inFlight : undefined);
    const puts = () => a.net.requests.filter((r) => r.startsWith('PUT /api/plans/')).length;
    const before = puts();
    const first = a.engine.runOnce();
    await expect.poll(puts).toBe(before + 1);
    // Retour du réseau (évènement « online ») : délais remis à zéro, cycle demandé.
    a.net.online = true;
    await a.engine.resetBackoff();
    const second = a.engine.runOnce();
    // La requête partie hors ligne échoue APRÈS la remise à zéro.
    a.net.beforeRequest = undefined;
    release(false);
    await Promise.all([first, second]);
    // Attendu : le cycle demandé au retour du réseau a bien eu lieu → modification envoyée.
    expect(await a.engine.outbox.list()).toHaveLength(0);
    expect(await serverVersions(doc.plan.id)).toEqual([1, 2]);
    a.close();
  });
});

describe('révocation d’accès (appareil de confiance)', () => {
  it('modifications hors ligne pendant une suspension : jamais envoyées, même après réactivation et reconnexion ; copie mise de côté', async () => {
    const admin = await h.login('admin@pamm.test');
    const e = await device(h, 'edition@pamm.test', h.orgA.id);
    const m = await device(h, 'gestion@pamm.test', h.orgA.id);
    const { doc } = await newLocalPlan(m);
    await m.sync();
    await e.sync();
    const epochBefore = e.epoch();
    // L'éditeur travaille hors ligne ; pendant ce temps, son accès est suspendu puis rétabli.
    e.net.online = false;
    await edit(e, doc.plan.id, 'modifié pendant la révocation');
    const id = h.users.editorA.id;
    await admin.req('PATCH', `/api/members/${id}`, { body: { status: 'disabled' } });
    await admin.req('PATCH', `/api/members/${id}`, { body: { status: 'active' } });
    // Retour en ligne : l'ancienne session est refusée ; rien n'est envoyé.
    e.net.online = true;
    await e.engine.resetBackoff();
    await e.sync();
    expect(e.engine.status.authRequired).toBe(true);
    expect(await serverVersions(doc.plan.id)).toEqual([1]);
    // Nouvelle connexion (nouvelle période d'accès) : la modification reste bloquée.
    await e.relogin();
    expect(e.epoch()).toBe(epochBefore! + 1);
    e.engine.status.authRequired = false;
    await e.sync();
    let ops = await e.engine.outbox.list();
    // Toutes les opérations de la période révoquée (plan et photo associée) sont bloquées.
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => o.revoked && o.status === 'blocked')).toBe(true);
    expect(ops.map((o) => o.kind)).toContain('plan.upsert');
    expect(await serverVersions(doc.plan.id)).toEqual([1]);
    // Une modification faite APRÈS la reconnexion s'appuie sur la version bloquée : elle attend.
    await edit(e, doc.plan.id, 'après reconnexion');
    await e.sync();
    expect(await serverVersions(doc.plan.id)).toEqual([1]);
    // Envoi forcé par un client qui ignorerait le blocage : refusé par le serveur.
    const forced = await h.app.inject({
      method: 'DELETE',
      url: `/api/plans/${doc.plan.id}`,
      headers: { 'x-campplanner': '1', 'if-match': '1', 'x-operation-epoch': String(epochBefore) },
    });
    expect([401, 409]).toContain(forced.statusCode);
    // « Garder ma version » ou « copie » ne contournent pas le blocage : refusés tant que les
    // modifications de la période révoquée n'ont pas été mises de côté.
    await expect(e.engine.keepMine(doc.plan.id)).rejects.toThrow(/révoqué/);
    await expect(e.engine.keepBothAsCopy(doc.plan.id, 'Copie')).rejects.toThrow(/révoqué/);
    // « Mettre de côté » : version locale archivée, version serveur reprise, file vide.
    ops = await e.engine.outbox.list();
    for (const op of ops.filter((o) => o.revoked)) await e.engine.discardRevoked(op.seq!);
    // Reste au plus l'envoi (idempotent) de la photo déjà présente sur le serveur ; plus aucune
    // modification du plan ni opération bloquée.
    const left = await e.engine.outbox.list();
    expect(left.filter((o) => o.revoked || o.entityType === 'plan')).toEqual([]);
    await e.sync();
    expect(await serverVersions(doc.plan.id)).toEqual([1]);
    expect((await e.repo.openPlan(doc.plan.id))!.doc.plan.titleBlock.notes).not.toBe('après reconnexion');
    const archive = await e.raw.sync.conflictArchive.toArray();
    expect(archive.map((a) => (a.doc as typeof doc).plan.titleBlock.notes)).toContain('après reconnexion');
    expect(await serverVersions(doc.plan.id)).toEqual([1]);
    e.close();
    m.close();
  });
});

describe('serveur restauré depuis une sauvegarde (retour arrière)', () => {
  it('rien n’est écrasé en silence : version locale plus récente = conflit ; plan inconnu du serveur restauré = conflit ; identique = relié', async () => {
    const { backup, restore } = await import('../src/ops/backup.ts');
    const { buildApp } = await import('../src/app.ts');
    const { createPool } = await import('../src/db.ts');
    const { FsStorage } = await import('../src/storage/fsStorage.ts');
    const { loadConfig } = await import('../src/config.ts');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const pgMod = await import('pg');
    const m = await device(h, 'gestion@pamm.test', h.orgA.id);
    const e = await device(h, 'edition@pamm.test', h.orgA.id);
    const stable = await newLocalPlan(m, 'Plan inchangé');
    const changed = await newLocalPlan(m, 'Plan modifié après la sauvegarde');
    await m.sync();
    await e.sync();
    // Sauvegarde complète du serveur.
    const dir = mkdtempSync(join(tmpdir(), 'cp-sync-backup-'));
    await backup({
      databaseUrl: h.db.ownerUrl,
      storage: h.storage,
      outDir: dir,
      pgBin: process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin',
    });
    // Après la sauvegarde : une modification (v2) et un nouveau plan, reçus par l'autre poste.
    await edit(m, changed.doc.plan.id, 'modifié après la sauvegarde');
    const later = await newLocalPlan(m, 'Plan créé après la sauvegarde');
    await m.sync();
    await e.sync();
    expect((await e.repo.openPlan(changed.doc.plan.id))!.doc.plan.titleBlock.notes).toBe(
      'modifié après la sauvegarde',
    );
    // Retour arrière : le serveur est restauré depuis la sauvegarde (autre base, nouvelle génération).
    const admin = new pgMod.default.Client({
      connectionString: h.db.ownerUrl.replace(/\/[^/]+$/, '/postgres'),
    });
    await admin.connect();
    const name = `cp_restauree_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const restoredUrl = h.db.ownerUrl.replace(/\/[^/]+$/, `/${name}`);
    const files = mkdtempSync(join(tmpdir(), 'cp-sync-restore-'));
    const storage = new FsStorage(files);
    const report = await restore({
      fromDir: dir,
      databaseUrl: restoredUrl,
      storage,
      pgBin: process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin',
    });
    expect(report.mismatches).toEqual([]);
    const appUrl = new URL(restoredUrl);
    appUrl.username = 'campplanner_app';
    appUrl.password = 'app';
    const pool = createPool(appUrl.toString());
    const app2 = await buildApp({
      config: loadConfig({ DATABASE_URL: appUrl.toString(), STORAGE_FS_ROOT: files }),
      pool,
      storage,
    });
    try {
      e.net.app = app2;
      await e.relogin();
      await e.sync();
      // Version locale plus récente que le serveur restauré : conflit, copie locale intacte.
      const conflicts = await e.raw.sync.conflicts.toArray();
      const byPlan = new Map(conflicts.map((c) => [c.planId, c.reason]));
      expect(byPlan.get(changed.doc.plan.id)).toBe('version');
      expect((await e.repo.openPlan(changed.doc.plan.id))!.doc.plan.titleBlock.notes).toBe(
        'modifié après la sauvegarde',
      );
      // Plan inconnu du serveur restauré : conflit « supprimé », copie locale intacte.
      expect(byPlan.get(later.doc.plan.id)).toBe('deleted');
      expect(await e.repo.openPlan(later.doc.plan.id)).toBeTruthy();
      // Plan identique des deux côtés : simplement relié, pas de conflit.
      expect(byPlan.has(stable.doc.plan.id)).toBe(false);
      const link = await e.raw.sync.syncLinks.get(`plan:${stable.doc.plan.id}`);
      expect(link?.restored).toBeFalsy();
      expect(link?.serverVersion).toBe(1);
      // Aucune écriture n'est partie vers le serveur restauré sans décision.
      const owner = new pgMod.default.Client({ connectionString: restoredUrl });
      await owner.connect();
      const versions = await owner.query('SELECT count(*)::int AS n FROM plan_versions');
      await owner.end();
      expect(versions.rows[0].n).toBe(report.manifest.counts.plan_versions);
    } finally {
      await app2.close();
      await pool.end();
      m.close();
      e.close();
    }
  }, 60_000);
});

describe('revue 9.1 : en-têtes, génération, relecture interrompue', () => {
  it('toutes les écritures (camp, fichier, plan) portent la période d’accès et la génération du serveur', async () => {
    const m = await device(h, 'gestion@pamm.test', h.orgA.id);
    try {
      await m.sync(); // première lecture : génération connue
      m.net.sent = [];
      await newLocalPlan(m, 'Plan en-têtes');
      await m.sync();
      const writes = m.net.sent.filter((r) => r.method !== 'GET');
      expect(writes.map((r) => r.url.split('/')[2])).toEqual(
        expect.arrayContaining(['camps', 'files', 'plans']),
      );
      for (const w of writes) {
        expect(w.headers['X-Operation-Epoch'], w.url).toBe(String(m.epoch()));
        expect(w.headers['X-Server-Generation'], w.url).toMatch(/.+/);
      }
    } finally {
      m.close();
    }
  });

  it('génération changée (serveur restauré) : l’envoi préparé avant est refusé, la différence devient un conflit ; relecture interrompue reprise au cycle suivant', async () => {
    const m = await device(h, 'gestion@pamm.test', h.orgA.id);
    try {
      const stable = await newLocalPlan(m, 'Inchangé');
      const changed = await newLocalPlan(m, 'Modifié hors ligne');
      await m.sync();
      // Plan « créé après la sauvegarde » : lié localement, inconnu du serveur restauré.
      const ghost = await newLocalPlan(m, 'Inconnu du serveur restauré');
      await m.raw.sync.outbox.clear();
      await m.raw.sync.syncLinks.put({
        key: `plan:${ghost.doc.plan.id}`,
        entityType: 'plan',
        entityId: ghost.doc.plan.id,
        serverVersion: 1,
        syncedAt: new Date().toISOString(),
      });
      await edit(m, changed.doc.plan.id, 'préparé avant la restauration');
      await h.db.owner.query(
        "UPDATE server_meta SET value = gen_random_uuid()::text WHERE key = 'generation'",
      );
      // Relecture interrompue : la lecture du plan modifié échoue (coupure) au premier cycle.
      let cut = true;
      m.net.beforeRequest = (method, url) =>
        cut && method === 'GET' && url.startsWith(`/api/plans/${changed.doc.plan.id}`)
          ? ((cut = false), Promise.reject(new Error('coupure')))
          : undefined;
      await m.sync();
      expect(await serverVersions(changed.doc.plan.id)).toEqual([1]); // 409 generation : rien d'écrit
      expect(cut).toBe(false); // la coupure a bien eu lieu pendant la relecture
      expect((await m.raw.sync.syncState.get('restorePass'))?.value).toBe(true);
      // Cycle suivant : la relecture reprend et se termine.
      await m.engine.resetBackoff();
      await m.sync();
      expect((await m.raw.sync.syncState.get('restorePass'))?.value).toBe(false);
      const conflicts = new Map((await m.raw.sync.conflicts.toArray()).map((c) => [c.planId, c.reason]));
      expect(conflicts.get(changed.doc.plan.id)).toBe('version');
      expect(conflicts.get(ghost.doc.plan.id)).toBe('deleted');
      expect(conflicts.has(stable.doc.plan.id)).toBe(false);
      expect((await m.raw.sync.syncLinks.toArray()).filter((l) => l.restored)).toEqual([]);
      expect((await m.repo.openPlan(changed.doc.plan.id))!.doc.plan.titleBlock.notes).toBe(
        'préparé avant la restauration',
      );
      expect(await serverVersions(changed.doc.plan.id)).toEqual([1]);
    } finally {
      m.close();
    }
  });
});

describe('déploiement pilote : expiration de la session', () => {
  it('session expirée : rien n’est envoyé ni perdu ; après reconnexion, tout part ; la nouvelle session a une nouvelle échéance', async () => {
    const m = await device(h, 'gestion@pamm.test', h.orgA.id);
    try {
      const { doc } = await newLocalPlan(m, 'Plan session expirée');
      await m.sync();
      expect(await serverVersions(doc.plan.id)).toEqual([1]);
      // Échéance atteinte (durée fixe : 30 jours sur un appareil de confiance, 12 h sur un poste partagé).
      await h.db.owner.query(
        "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1",
        [h.users.managerA.id],
      );
      await edit(m, doc.plan.id, 'modifié après expiration');
      await m.sync();
      expect(m.engine.status.authRequired).toBe(true);
      expect(await serverVersions(doc.plan.id)).toEqual([1]);
      expect((await m.engine.outbox.list()).some((o) => o.entityId === doc.plan.id)).toBe(true);
      // Nouvelle connexion : la modification en attente part, rien n'est perdu.
      await m.relogin();
      m.engine.status.authRequired = false;
      await m.sync();
      expect(await serverVersions(doc.plan.id)).toEqual([1, 2]);
      const latest = await h.db.owner.query(
        "SELECT document #>> '{plan,titleBlock,notes}' AS n FROM plan_versions WHERE plan_id = $1 AND version = 2",
        [doc.plan.id],
      );
      expect(latest.rows[0].n).toBe('modifié après expiration');
      const next = await h.db.owner.query(
        "SELECT max(expires_at) > now() + interval '29 days' AS ok FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
        [h.users.managerA.id],
      );
      expect(next.rows[0].ok).toBe(true);
    } finally {
      m.close();
    }
  });
});
