/** API de synchronisation des plans : concurrence optimiste, idempotence, historique, suppressions. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiClient, createHarness, type Harness, putPlan, seedPlan } from './harness.ts';

let h: Harness;
let manager: ApiClient;
let editor: ApiClient;
beforeAll(async () => {
  h = await createHarness();
  manager = await h.login('gestion@pamm.test');
  editor = await h.login('edition@pamm.test');
});
afterAll(() => h.close());

describe('plans synchronisés', () => {
  it('version périmée : 409 avec la version serveur, son auteur et sa date — rien n’est écrasé', async () => {
    const { doc } = await seedPlan(manager);
    const mine = structuredClone(doc);
    mine.plan.titleBlock.notes = 'poste 1';
    const theirs = structuredClone(doc);
    theirs.plan.titleBlock.notes = 'poste 2';
    expect((await putPlan(editor, theirs, 1)).statusCode).toBe(200); // l'autre poste passe d'abord
    const conflict = await putPlan(manager, mine, 1);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: 'version',
      serverVersion: 2,
      updatedBy: 'N. Tremblay',
      deleted: false,
    });
    expect(Date.parse(conflict.json().updatedAt)).toBeGreaterThan(0);
    const server = (await manager.req('GET', `/api/plans/${doc.plan.id}`)).json();
    expect(server.document.plan.titleBlock.notes).toBe('poste 2');
    // « Garder ma version » (choix explicite) : envoyée sur la version serveur ; l'autre reste dans l'historique.
    expect((await putPlan(manager, mine, 2)).statusCode).toBe(200);
    const versions = (await manager.req('GET', `/api/plans/${doc.plan.id}/versions`)).json().versions;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    const v2 = (await manager.req('GET', `/api/plans/${doc.plan.id}/versions/2`)).json().document;
    expect(v2.plan.titleBlock.notes).toBe('poste 2');
  });

  it('requête rejouée (même identifiant d’opération) : une seule modification', async () => {
    const { doc } = await seedPlan(manager);
    const next = structuredClone(doc);
    next.plan.titleBlock.notes = 'une fois';
    const first = await putPlan(manager, next, 1, 'op-rejouee-0001');
    const second = await putPlan(manager, next, 1, 'op-rejouee-0001');
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const versions = (await manager.req('GET', `/api/plans/${doc.plan.id}/versions`)).json().versions;
    expect(versions).toHaveLength(2);
    // Même clé réutilisée pour une autre requête : refusée.
    const other = await manager.req('PUT', `/api/camps/${doc.plan.siteId}`, {
      body: { name: 'X' },
      headers: { 'if-match': '1', 'idempotency-key': 'op-rejouee-0001' },
    });
    expect(other.statusCode).toBe(422);
  });

  it('création en double (deux envois concurrents du même nouveau plan) : un seul plan', async () => {
    const { doc } = await seedPlan(manager);
    const copy = structuredClone(doc);
    copy.plan.id = 'plan-double-01';
    const [a, b] = await Promise.all([putPlan(manager, copy, 0), putPlan(manager, copy, 0)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const n = await h.db.owner.query("SELECT count(*)::int AS n FROM plans WHERE id = 'plan-double-01'");
    expect(n.rows[0].n).toBe(1);
  });

  it('suppression logique : conflit « supprimé » pour un envoi ultérieur ; restauration ; flux des changements', async () => {
    const { doc } = await seedPlan(manager);
    const cursor = (await manager.req('GET', '/api/sync/changes?since=0&limit=2000')).json().cursor;
    expect(
      (await manager.req('DELETE', `/api/plans/${doc.plan.id}`, { headers: { 'if-match': '1' } })).statusCode,
    ).toBe(200);
    const late = await putPlan(editor, doc, 1);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: 'deleted', deleted: true });
    const changes = (await manager.req('GET', `/api/sync/changes?since=${cursor}`)).json().changes;
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'plan', id: doc.plan.id, deleted: true }));
    expect((await editor.req('POST', `/api/plans/${doc.plan.id}/restore`)).statusCode).toBe(403);
    expect((await manager.req('POST', `/api/plans/${doc.plan.id}/restore`)).json().serverVersion).toBe(3);
    const restored = (await manager.req('GET', `/api/plans/${doc.plan.id}`)).json();
    expect(restored.deleted).toBe(false);
    expect(restored.document.plan.id).toBe(doc.plan.id);
  });

  it('If-Match obligatoire ; document invalide ou incohérent refusé', async () => {
    const { doc } = await seedPlan(manager);
    const noMatch = await manager.req('PUT', `/api/plans/${doc.plan.id}`, {
      body: { campId: doc.plan.siteId, document: doc },
    });
    expect(noMatch.statusCode).toBe(428);
    const broken = await manager.req('PUT', `/api/plans/${doc.plan.id}`, {
      body: { campId: doc.plan.siteId, document: { ...doc, layers: 'cassé' } },
      headers: { 'if-match': '1' },
    });
    expect(broken.json().error).toBe('invalid-document');
    const moved = await manager.req('PUT', `/api/plans/${doc.plan.id}`, {
      body: { campId: 'autre-camp-01', document: doc },
      headers: { 'if-match': '1' },
    });
    expect(moved.statusCode).toBe(422);
  });
});
