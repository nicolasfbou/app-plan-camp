/**
 * Sécurité serveur : chaque refus est vérifié CÔTÉ SERVEUR (aucune confiance dans le client).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeRevisionStatus } from '@/domain/revisions/revision.ts';
import { tx } from '../src/db.ts';
import {
  type ApiClient,
  createHarness,
  frozen,
  type Harness,
  jpeg,
  putPlan,
  seedPlan,
  sha256,
  uploadFile,
} from './harness.ts';

let h: Harness;
let adminA: ApiClient, managerA: ApiClient, editorA: ApiClient, readerA: ApiClient, adminB: ApiClient;
let planA: Awaited<ReturnType<typeof seedPlan>>;

beforeAll(async () => {
  h = await createHarness({ MAX_UPLOAD_BYTES: String(64 * 1024) });
  adminA = await h.login('admin@pamm.test');
  managerA = await h.login('gestion@pamm.test');
  editorA = await h.login('edition@pamm.test');
  readerA = await h.login('lecture@pamm.test');
  adminB = await h.login('admin@autre.test');
  planA = await seedPlan(managerA);
});
afterAll(() => h.close());

describe('isolation des organisations', () => {
  it('un utilisateur de B connaît l’ID d’un plan de A : lecture, modification, historique, révisions refusées', async () => {
    const id = planA.doc.plan.id;
    expect((await adminB.req('GET', `/api/plans/${id}`)).statusCode).toBe(404);
    expect((await adminB.req('GET', `/api/plans/${id}/versions`)).statusCode).toBe(404);
    expect((await adminB.req('GET', `/api/plans/${id}/revisions`)).statusCode).toBe(404);
    expect(
      (await adminB.req('DELETE', `/api/plans/${id}`, { headers: { 'if-match': '1' } })).statusCode,
    ).toBe(404);
    // Écriture « par-dessus » avec l'ID connu : le camp n'existe pas dans B → aucune écriture dans A.
    const w = await putPlan(adminB, planA.doc, 1);
    expect(w.statusCode).toBeGreaterThanOrEqual(400);
    expect((await managerA.req('GET', `/api/plans/${id}`)).json().serverVersion).toBe(1);
    const listB = await adminB.req('GET', '/api/plans');
    expect(listB.json().plans).toHaveLength(0);
    const changesB = await adminB.req('GET', '/api/sync/changes?since=0');
    expect(changesB.json().changes).toHaveLength(0);
  });

  it('accès direct à un fichier d’une autre organisation : même réponse qu’un fichier inexistant', async () => {
    const r = await adminB.req('GET', `/api/files/${sha256(planA.photo)}`);
    expect(r.statusCode).toBe(404);
    expect((await managerA.req('GET', `/api/files/${sha256(planA.photo)}`)).statusCode).toBe(200);
    expect(
      (await adminB.req('POST', '/api/files/check', { body: { sha256: [sha256(planA.photo)] } })).json()
        .present,
    ).toEqual([]);
  });

  it('faux organizationId dans la requête : ignoré, l’organisation vient de la session', async () => {
    const r = await adminB.req('PUT', '/api/camps/camp-faux-org', {
      body: { name: 'Intrus', organizationId: h.orgA.id },
      headers: { 'if-match': '0' },
    });
    expect(r.statusCode).toBe(201);
    const inA = await h.db.owner.query("SELECT organization_id FROM camps WHERE id = 'camp-faux-org'");
    expect(inA.rows.map((x) => x.organization_id)).toEqual([h.orgB.id]);
    expect(
      (await managerA.req('GET', '/api/camps')).json().camps.map((c: { id: string }) => c.id),
    ).not.toContain('camp-faux-org');
  });

  it('RLS : même une requête SQL sans filtre du rôle applicatif ne voit que son organisation', async () => {
    const seen = await tx(h.db.pool, { orgId: h.orgB.id, userId: h.users.adminB.id }, (c) =>
      c.query('SELECT id FROM plans'),
    );
    expect(seen.rows).toHaveLength(0);
  });
});

describe('rôles', () => {
  it('lecteur : consultation seulement, toute modification refusée', async () => {
    expect((await readerA.req('GET', `/api/plans/${planA.doc.plan.id}`)).statusCode).toBe(200);
    expect((await putPlan(readerA, planA.doc, 1)).statusCode).toBe(403);
    expect((await uploadFile(readerA, jpeg())).statusCode).toBe(403);
    const rev = await frozen(planA.doc, 'L');
    expect(
      (
        await readerA.req('PUT', `/api/revisions/${rev.meta.id}`, {
          body: { planId: planA.doc.plan.id, meta: rev.meta, snapshot: rev.json },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('éditeur : modifie un plan, crée une révision, mais ne peut ni approuver ni créer de camp', async () => {
    const doc = structuredClone(planA.doc);
    doc.plan.titleBlock.notes = 'édité';
    const put = await putPlan(editorA, doc, 1);
    expect(put.statusCode).toBe(200);
    planA.version = put.json().serverVersion;
    planA.doc = doc;
    expect(
      (
        await editorA.req('PUT', '/api/camps/camp-editeur', {
          body: { name: 'X' },
          headers: { 'if-match': '0' },
        })
      ).statusCode,
    ).toBe(403);
    const rev = await frozen(doc, 'E1');
    expect(
      (
        await editorA.req('PUT', `/api/revisions/${rev.meta.id}`, {
          body: { planId: doc.plan.id, meta: rev.meta, snapshot: rev.json },
        })
      ).statusCode,
    ).toBe(201);
    const approve = await editorA.req('POST', `/api/revisions/${rev.meta.id}/status`, {
      body: { to: 'approved', confirmed: true, comment: '' },
    });
    expect(approve.statusCode).toBe(403);
  });
});

describe('révisions : identité, approbation réelle, immuabilité', () => {
  it('faux userId (auteur, approbateur, journal) et fausse approbation « authentifiée » : refusés', async () => {
    const rev = await frozen(planA.doc, 'F1');
    const forgedAuthor = { ...rev.meta, authorUserId: h.users.managerA.id };
    const r1 = await editorA.req('PUT', `/api/revisions/${rev.meta.id}`, {
      body: { planId: planA.doc.plan.id, meta: forgedAuthor, snapshot: rev.json },
    });
    // Sceau cassé OU identité refusée : dans les deux cas, refus.
    expect(r1.statusCode).toBe(422);
    // Approbation « authentifiée » fabriquée par un client (sceau recalculé correctement).
    const forged = await changeRevisionStatus(
      rev.meta,
      {
        to: 'approved',
        by: 'M. Gagnon',
        comment: '',
        confirmed: true,
        verificationType: 'authenticated_server',
      },
      new Date().toISOString(),
    );
    const r2 = await managerA.req('PUT', `/api/revisions/${forged.id}`, {
      body: { planId: planA.doc.plan.id, meta: forged, snapshot: rev.json },
    });
    expect(r2.statusCode).toBe(422);
    expect(r2.json().error).toBe('forged-approval');
    const withUser = await changeRevisionStatus(
      rev.meta,
      { to: 'approved', by: 'M. Gagnon', userId: h.users.managerA.id, comment: '', confirmed: true },
      new Date().toISOString(),
    );
    const r3 = await managerA.req('PUT', `/api/revisions/${withUser.id}`, {
      body: { planId: planA.doc.plan.id, meta: withUser, snapshot: rev.json },
    });
    expect(r3.json().error).toBe('forged-identity');
  });

  it('instantané ou sceau altérés : refusés', async () => {
    const rev = await frozen(planA.doc, 'T1');
    const badSnap = await managerA.req('PUT', `/api/revisions/${rev.meta.id}`, {
      body: {
        planId: planA.doc.plan.id,
        meta: rev.meta,
        snapshot: rev.json.replace('"objects"', '"objects" '),
      },
    });
    expect(badSnap.json().error).toBe('snapshot-mismatch');
    const badSeal = await managerA.req('PUT', `/api/revisions/${rev.meta.id}`, {
      body: { planId: planA.doc.plan.id, meta: { ...rev.meta, description: 'modifiée' }, snapshot: rev.json },
    });
    expect(badSeal.json().error).toBe('seal-broken');
  });

  it('approbation : compte, nom figé, date SERVEUR, audit dans la même transaction ; puis immuable', async () => {
    const rev = await frozen(planA.doc, 'B');
    const created = await managerA.req('PUT', `/api/revisions/${rev.meta.id}`, {
      body: { planId: planA.doc.plan.id, meta: rev.meta, snapshot: rev.json },
    });
    expect(created.statusCode).toBe(201);
    // Double envoi : aucune seconde révision.
    const again = await managerA.req('PUT', `/api/revisions/${rev.meta.id}`, {
      body: { planId: planA.doc.plan.id, meta: rev.meta, snapshot: rev.json },
    });
    expect(again.statusCode).toBe(200);
    const before = Date.now();
    const approved = await managerA.req('POST', `/api/revisions/${rev.meta.id}/status`, {
      body: { to: 'approved', confirmed: true, comment: 'Conforme' },
    });
    expect(approved.statusCode).toBe(200);
    const v = approved.json();
    expect(v.verificationType).toBe('authenticated_server');
    expect(v.approvedBy).toEqual({ id: h.users.managerA.id, name: 'M. Gagnon' });
    expect(v.meta.approval).toMatchObject({
      by: 'M. Gagnon',
      approverUserId: h.users.managerA.id,
      verificationType: 'authenticated_server',
      comment: 'Conforme',
    });
    expect(Date.parse(v.approvedAt)).toBeGreaterThanOrEqual(before - 5000);
    const auditRow = await h.db.owner.query(
      "SELECT user_id, context FROM audit_events WHERE action = 'revision.approve' AND target_id = $1",
      [rev.meta.id],
    );
    expect(auditRow.rows).toHaveLength(1);
    expect(auditRow.rows[0].user_id).toBe(h.users.managerA.id);

    // Modification par l'API : refusée (seul l'archivage reste possible).
    const back = await managerA.req('POST', `/api/revisions/${rev.meta.id}/status`, {
      body: { to: 'review', confirmed: true },
    });
    expect(back.statusCode).toBe(409);
    expect((await adminA.req('DELETE', `/api/revisions/${rev.meta.id}`)).statusCode).toBe(409);
    // Requête SQL DIRECTE du rôle applicatif (client malveillant, bogue) : refusée par la base.
    await expect(
      tx(h.db.pool, { orgId: h.orgA.id, userId: null }, (c) =>
        c.query("UPDATE revisions SET status = 'review', meta = '{}'::json WHERE id = $1", [rev.meta.id]),
      ),
    ).rejects.toThrow(/révision approuvée immuable|champs figés/);
    await expect(
      tx(h.db.pool, { orgId: h.orgA.id, userId: null }, (c) =>
        c.query('DELETE FROM revisions WHERE id = $1', [rev.meta.id]),
      ),
    ).rejects.toThrow();
    await expect(
      tx(h.db.pool, { orgId: h.orgA.id, userId: null }, (c) =>
        c.query("UPDATE revision_snapshots SET json = '{}' WHERE revision_id = $1", [rev.meta.id]),
      ),
    ).rejects.toThrow();
    // Archivage : permis, approbation conservée.
    const archived = await managerA.req('POST', `/api/revisions/${rev.meta.id}/status`, {
      body: { to: 'archived' },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().meta.approval.approverUserId).toBe(h.users.managerA.id);
  });

  it('approbation locale publiée : conservée comme « non vérifiée », jamais officielle', async () => {
    const rev = await frozen(planA.doc, 'L0');
    const local = await changeRevisionStatus(
      rev.meta,
      { to: 'approved', by: 'Chef de camp (déclaré)', comment: 'OK', confirmed: true },
      '2025-06-01T12:00:00.000Z',
    );
    const r = await managerA.req('PUT', `/api/revisions/${local.id}`, {
      body: { planId: planA.doc.plan.id, meta: local, snapshot: rev.json },
    });
    expect(r.statusCode).toBe(201);
    const list = (await managerA.req('GET', `/api/plans/${planA.doc.plan.id}/revisions`)).json().revisions;
    const stored = list.find((x: { id: string }) => x.id === local.id);
    expect(stored).toMatchObject({
      verificationType: 'local_unverified',
      approvedAt: null,
      approvedBy: null,
    });
    expect(stored.meta.approval).toEqual(local.approval); // jamais réécrite
    expect(stored.meta.seal).toBe(local.seal);
  });
});

describe('fichiers', () => {
  it('SVG dangereux refusé ; SVG sûr accepté', async () => {
    const bad = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r = await uploadFile(editorA, bad, 'image/svg+xml');
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe('unsafe-svg');
    const onload = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect onload="x()" width="1" height="1"/></svg>',
    );
    expect((await uploadFile(editorA, onload, 'image/svg+xml')).statusCode).toBe(422);
    const ok = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4" fill="red"/></svg>',
    );
    expect((await uploadFile(editorA, ok, 'image/svg+xml')).statusCode).toBe(201);
  });

  it('envoi surdimensionné, SHA menteur, type déguisé : refusés ; renvoi identique : idempotent', async () => {
    expect((await uploadFile(editorA, jpeg(70 * 1024))).statusCode).toBe(413);
    const bytes = jpeg();
    const liar = await editorA.req('PUT', `/api/files/${sha256(Buffer.from('autre chose'))}`, {
      raw: bytes,
      headers: { 'x-file-type': 'image/jpeg' },
    });
    expect(liar.json().error).toBe('sha-mismatch');
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect((await uploadFile(editorA, html, 'image/png')).statusCode).toBe(415);
    expect((await uploadFile(editorA, bytes)).statusCode).toBe(201);
    const second = await uploadFile(editorA, bytes);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    const rows = await h.db.owner.query('SELECT count(*)::int AS n FROM files WHERE sha256 = $1', [
      sha256(bytes),
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('plan référençant un fichier absent (ou d’une autre organisation) : refusé', async () => {
    const doc = structuredClone(planA.doc);
    const foreign = jpeg();
    await uploadFile(adminB, foreign);
    doc.plan.baseImage = { ...doc.plan.baseImage!, sha256: sha256(foreign) };
    const r = await putPlan(managerA, doc, planA.version);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe('missing-files');
  });
});

describe('journal d’audit', () => {
  it('lisible par l’administrateur, refusé au lecteur ; aucune donnée du plan', async () => {
    expect((await readerA.req('GET', '/api/audit')).statusCode).toBe(403);
    const events = (await adminA.req('GET', '/api/audit')).json().events as {
      action: string;
      context: unknown;
    }[];
    const actions = new Set(events.map((e) => e.action));
    for (const a of [
      'plan.create',
      'plan.update',
      'revision.create',
      'revision.approve',
      'file.upload',
      'auth.login',
    ])
      expect(actions).toContain(a);
    expect(JSON.stringify(events)).not.toContain('"objects":{');
    expect(
      (await adminB.req('GET', '/api/audit'))
        .json()
        .events.every((e: { action: string }) => e.action !== 'plan.create'),
    ).toBe(true);
  });
});
