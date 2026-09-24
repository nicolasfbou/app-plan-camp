/**
 * Isolation des organisations, ressource par ressource (phase 9.1) : l'utilisateur de B connaît
 * les identifiants de A (plan, révision, photo, modèle, camp) et essaie de les lire, de les
 * modifier ou de les référencer depuis ses propres ressources. Tout est refusé, et rien ne change
 * dans A. Contrôles vérifiés dans l'API (organisation de la session dans chaque requête) ; la RLS
 * reste une seconde barrière.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createPlanDocument, createSite } from '@/domain/model/factories.ts';
import { templateFromPlan } from '@/domain/templates/template.ts';
import {
  type ApiClient,
  createHarness,
  frozen,
  type Harness,
  putPlan,
  seedPlan,
  sha256,
  uploadFile,
} from './harness.ts';

// Deux passes : RLS active (production) puis rôle qui CONTOURNE la RLS — l'API seule doit
// suffire à isoler les organisations (défense en profondeur, pas un seul rempart).
describe.each([
  { mode: 'RLS active', bypassRls: false },
  { mode: 'RLS contournée (contrôles API seuls)', bypassRls: true },
])('$mode', ({ bypassRls }) => {
  let h: Harness;
  let managerA: ApiClient, adminB: ApiClient;
  let planA: Awaited<ReturnType<typeof seedPlan>>;
  let revisionA: string;
  let templateA: string;
  /** Faux PNG (vraie signature) : le serveur vérifie le type réel par les octets magiques. */
  const png = (size = 2048) => {
    const b = randomBytes(size);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
    return b;
  };
  const logo = png();
  const logoMeta = (bytes: Buffer) => ({
    name: 'logo.png',
    mimeType: 'image/png' as const,
    sha256: sha256(bytes),
    byteLength: bytes.length,
  });

  beforeAll(async () => {
    h = await createHarness({}, { bypassRls });
    managerA = await h.login('gestion@pamm.test');
    adminB = await h.login('admin@autre.test');
    planA = await seedPlan(managerA);
    const rev = await frozen(planA.doc, 'A');
    revisionA = rev.meta.id;
    const r = await managerA.req('PUT', `/api/revisions/${rev.meta.id}`, {
      body: { planId: planA.doc.plan.id, meta: rev.meta, snapshot: rev.json },
    });
    expect(r.statusCode).toBe(201);
    expect((await uploadFile(managerA, logo, 'image/png')).statusCode).toBe(201);
    const template = templateFromPlan(planA.doc, 'Modèle PAMM', { logo: logoMeta(logo) });
    templateA = template.id;
    const t = await managerA.req('PUT', `/api/templates/${template.id}`, {
      body: { template },
      headers: { 'if-match': '0' },
    });
    expect(t.statusCode).toBe(201);
  });
  afterAll(() => h.close());

  const unchangedA = async () => {
    const plan = (await managerA.req('GET', `/api/plans/${planA.doc.plan.id}`)).json();
    expect(plan.serverVersion).toBe(1);
    expect((await managerA.req('GET', `/api/revisions/${revisionA}`)).statusCode).toBe(200);
  };

  describe('photos (fichiers)', () => {
    it('B : lecture directe, vérification de présence et référence depuis son propre plan refusées', async () => {
      const sha = sha256(planA.photo);
      expect((await adminB.req('GET', `/api/files/${sha}`)).statusCode).toBe(404);
      expect(
        (await adminB.req('POST', '/api/files/check', { body: { sha256: [sha] } })).json().present,
      ).toEqual([]);
      // B crée son camp et un plan qui RÉFÉRENCE la photo de A (SHA connu) : refusé.
      const site = createSite('Camp B');
      expect(
        (
          await adminB.req('PUT', `/api/camps/${site.id}`, {
            body: { name: 'Camp B' },
            headers: { 'if-match': '0' },
          })
        ).statusCode,
      ).toBe(201);
      const doc = createPlanDocument({ siteId: site.id, name: 'Plan B' });
      doc.plan.baseImage = { ...planA.doc.plan.baseImage! };
      const r = await putPlan(adminB, doc, 0);
      expect(r.statusCode).toBe(422);
      expect(r.json().error).toBe('missing-files');
    });

    it('B envoie la même photo (même SHA) : copie distincte dans B, jamais la ressource de A', async () => {
      expect((await uploadFile(adminB, planA.photo)).statusCode).toBe(201);
      const rows = await h.db.owner.query(
        'SELECT organization_id, storage_key FROM files WHERE sha256 = $1',
        [sha256(planA.photo)],
      );
      expect(rows.rows).toHaveLength(2);
      expect(new Set(rows.rows.map((r) => r.storage_key)).size).toBe(2);
    });
  });

  describe('plans', () => {
    it('B : lecture, versions, version précise, suppression, restauration, écriture par-dessus : refusées', async () => {
      const id = planA.doc.plan.id;
      expect((await adminB.req('GET', `/api/plans/${id}`)).statusCode).toBe(404);
      expect((await adminB.req('GET', `/api/plans/${id}/versions`)).statusCode).toBe(404);
      expect((await adminB.req('GET', `/api/plans/${id}/versions/1`)).statusCode).toBe(404);
      expect(
        (await adminB.req('DELETE', `/api/plans/${id}`, { headers: { 'if-match': '1' } })).statusCode,
      ).toBe(404);
      expect((await adminB.req('POST', `/api/plans/${id}/restore`)).statusCode).toBe(404);
      // Le document de A renvoyé tel quel par B (campId de A) : camp inexistant dans B.
      const w = await putPlan(adminB, planA.doc, 0);
      expect(w.statusCode).toBe(409);
      expect(w.json().error).toBe('camp-missing');
      await unchangedA();
    });

    it('B : liste, flux des changements et vérification de publication ne révèlent rien de A', async () => {
      expect(
        (await adminB.req('GET', '/api/plans')).json().plans.map((p: { id: string }) => p.id),
      ).not.toContain(planA.doc.plan.id);
      const changes = (await adminB.req('GET', '/api/sync/changes?since=0&limit=2000')).json().changes;
      expect(changes.map((c: { id: string }) => c.id)).not.toContain(planA.doc.plan.id);
      const check = (
        await adminB.req('POST', '/api/publish/check', {
          body: {
            campIds: [planA.site.id],
            planIds: [planA.doc.plan.id],
            revisionIds: [revisionA],
            sha256: [sha256(logo)],
          },
        })
      ).json();
      expect(check).toEqual({ existing: { camps: [], plans: [], revisions: [] }, presentFiles: [] });
    });
  });

  describe('camps', () => {
    it('B : suppression du camp de A refusée ; « création » avec le même identifiant = camp distinct dans B', async () => {
      expect(
        (await adminB.req('DELETE', `/api/camps/${planA.site.id}`, { headers: { 'if-match': '1' } }))
          .statusCode,
      ).toBe(404);
      const r = await adminB.req('PUT', `/api/camps/${planA.site.id}`, {
        body: { name: 'Intrus' },
        headers: { 'if-match': '0' },
      });
      expect(r.statusCode).toBe(201);
      const campsA = (await managerA.req('GET', '/api/camps')).json().camps as { id: string; name: string }[];
      expect(campsA.find((c) => c.id === planA.site.id)!.name).toBe('Camp 105');
    });
  });

  describe('révisions', () => {
    it('B : lecture, changement de statut, approbation, suppression, dépôt sur le plan de A : refusés', async () => {
      expect((await adminB.req('GET', `/api/revisions/${revisionA}`)).statusCode).toBe(404);
      for (const to of ['review', 'approved'])
        expect(
          (
            await adminB.req('POST', `/api/revisions/${revisionA}/status`, {
              body: { to, confirmed: true, comment: '' },
            })
          ).statusCode,
        ).toBe(404);
      expect((await adminB.req('DELETE', `/api/revisions/${revisionA}`)).statusCode).toBe(404);
      // Révision déposée par B sur le plan de A (planId connu) : le plan n'existe pas pour B.
      const rev = await frozen(planA.doc, 'X');
      const r = await adminB.req('PUT', `/api/revisions/${rev.meta.id}`, {
        body: { planId: planA.doc.plan.id, meta: rev.meta, snapshot: rev.json },
      });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('plan-missing');
      await unchangedA();
      const row = await h.db.owner.query('SELECT status FROM revisions WHERE id = $1', [revisionA]);
      expect(row.rows[0].status).toBe('review');
    });
  });

  describe('modèles', () => {
    it('B : liste sans les modèles de A ; suppression refusée ; logo de A non référençable', async () => {
      const listA = (await managerA.req('GET', '/api/templates')).json().templates as { id: string }[];
      expect(listA.map((t) => t.id)).toContain(templateA);
      const listB = (await adminB.req('GET', '/api/templates')).json().templates as { id: string }[];
      expect(listB.map((t) => t.id)).not.toContain(templateA);
      expect((await adminB.req('DELETE', `/api/templates/${templateA}`)).statusCode).toBe(404);
      expect((await managerA.req('GET', '/api/templates')).json().templates).toHaveLength(listA.length);
      // Modèle de B avec le logo de A (SHA connu, jamais envoyé par B) : refusé.
      const template = templateFromPlan(planA.doc, 'Modèle B', { logo: logoMeta(logo) });
      const r = await adminB.req('PUT', `/api/templates/${template.id}`, {
        body: { template },
        headers: { 'if-match': '0' },
      });
      expect(r.statusCode).toBe(422);
      expect(r.json().error).toBe('missing-files');
      expect((await adminB.req('GET', `/api/files/${sha256(logo)}`)).statusCode).toBe(404);
    });
  });

  describe('journal d’audit et membres', () => {
    it('B ne voit que les évènements de B ; ne peut ni lister ni modifier les membres de A', async () => {
      const events = (await adminB.req('GET', '/api/audit?limit=500')).json().events as {
        targetId: string;
      }[];
      expect(events.length).toBeGreaterThan(0);
      const leaked = events.filter((e) => [planA.doc.plan.id, revisionA, templateA].includes(e.targetId));
      expect(leaked).toEqual([]);
      const actorsB = await h.db.owner.query(
        'SELECT DISTINCT organization_id FROM audit_events WHERE id = ANY($1::bigint[])',
        [(await adminB.req('GET', '/api/audit?limit=500')).json().events.map((e: { id: number }) => e.id)],
      );
      expect(actorsB.rows.map((r) => r.organization_id)).toEqual([h.orgB.id]);
      const membersB = (await adminB.req('GET', '/api/members')).json().members as { email: string }[];
      expect(membersB.map((m) => m.email)).toEqual(['admin@autre.test']);
      // userId d'un membre de A fourni par B : aucun effet sur A.
      const r = await adminB.req('PATCH', `/api/members/${h.users.managerA.id}`, {
        body: { status: 'disabled' },
      });
      expect(r.statusCode).toBe(404);
      expect((await managerA.req('GET', '/api/auth/me')).statusCode).toBe(200);
    });
  });
});
