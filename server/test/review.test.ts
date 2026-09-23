/**
 * Corrections de la revue indépendante de la phase 9 (chaque test reproduit le défaut signalé).
 */
import { freezeRevision, changeRevisionStatus } from '@/domain/revisions/revision.ts';
import { newId } from '@/domain/model/factories.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRowSecurityApplies, tx } from '../src/db.ts';
import { logChange } from '../src/sync.ts';
import {
  type ApiClient,
  createHarness,
  frozen,
  type Harness,
  PASSWORD,
  putPlan,
  seedPlan,
  sha256,
} from './harness.ts';

let h: Harness;
let manager: ApiClient;
let editor: ApiClient;
beforeAll(async () => {
  h = await createHarness();
  manager = await h.login('gestion@pamm.test');
  editor = await h.login('edition@pamm.test');
});
afterAll(() => h.close());

describe('idempotence : même clé, contenu différent', () => {
  it('réponse perdue puis nouvelles modifications : refusé (422) avec la réponse d’origine, rien d’écrasé', async () => {
    const { doc } = await seedPlan(manager);
    const v1 = structuredClone(doc);
    v1.plan.titleBlock.notes = 'V1';
    const first = await putPlan(manager, v1, 1, 'op-reponse-perdue-1');
    expect(first.statusCode).toBe(200);
    const v2 = structuredClone(doc);
    v2.plan.titleBlock.notes = 'V2';
    const replay = await putPlan(manager, v2, 1, 'op-reponse-perdue-1');
    expect(replay.statusCode).toBe(422);
    expect(replay.json()).toMatchObject({
      error: 'idempotency-key-reused',
      previous: { status: 200, body: { serverVersion: 2 } },
    });
    // Le client renvoie le contenu actuel sous une nouvelle clé, sur la version reçue.
    expect((await putPlan(manager, v2, 2, 'op-reponse-perdue-2')).statusCode).toBe(200);
    const server = (await manager.req('GET', `/api/plans/${doc.plan.id}`)).json();
    expect(server.document.plan.titleBlock.notes).toBe('V2');
  });
});

describe('journal des changements : aucun changement sauté', () => {
  it('une transaction validée APRÈS une autre, mais numérotée avant, reste visible au curseur suivant', async () => {
    const { doc } = await seedPlan(manager);
    const cursor = (await manager.req('GET', '/api/sync/changes?since=0&limit=2000')).json().cursor as number;
    // Transaction lente : son changement est inscrit, mais pas encore validé.
    const slow = await h.db.pool.connect();
    await slow.query('BEGIN');
    await slow.query("SELECT set_config('app.org_id', $1, true)", [h.orgA.id]);
    await logChange(slow, h.orgA.id, 'template', 'modele-lent-01', 1);
    // Écriture rapide pendant ce temps : elle attend l'ordre de validation.
    const next = structuredClone(doc);
    next.plan.titleBlock.notes = 'rapide';
    const fast = putPlan(manager, next, 1);
    await new Promise((r) => setTimeout(r, 300));
    const during = (await manager.req('GET', `/api/sync/changes?since=${cursor}`)).json();
    expect(during.changes).toEqual([]); // rien de visible ne peut dépasser la transaction lente
    await slow.query('COMMIT');
    slow.release();
    expect((await fast).statusCode).toBe(200);
    const after = (await manager.req('GET', `/api/sync/changes?since=${during.cursor}`)).json();
    expect(after.changes.map((c: { id: string }) => c.id)).toEqual(['modele-lent-01', doc.plan.id]);
  });
});

describe('révisions : statut et approbation réservés', () => {
  it('éditeur : ni révision « approuvée » fabriquée, ni historique de statut ; un gestionnaire (publication) oui, « non vérifiée »', async () => {
    const { doc } = await seedPlan(manager);
    const rev = await frozen(doc, 'A');
    const approved = await changeRevisionStatus(
      rev.meta,
      { to: 'approved', by: 'Directeur général', comment: '', approvalDate: '2026-09-01', confirmed: true },
      new Date().toISOString(),
    );
    const put = (api: ApiClient, meta: unknown) =>
      api.req('PUT', `/api/revisions/${rev.meta.id}`, {
        body: { planId: doc.plan.id, meta, snapshot: rev.json },
      });
    expect((await put(editor, approved)).statusCode).toBe(403);
    const inReview = await changeRevisionStatus(
      rev.meta,
      { to: 'field-validation', by: 'N. Tremblay', comment: '' },
      new Date().toISOString(),
    );
    expect((await put(editor, inReview)).statusCode).toBe(403);
    // Publication d'un projet local (gestionnaire) : approbation déclarée conservée, non vérifiée.
    expect((await put(manager, approved)).statusCode).toBe(201);
    const row = await h.db.owner.query('SELECT verification_type FROM revisions WHERE id = $1', [
      rev.meta.id,
    ]);
    expect(row.rows[0].verification_type).toBe('local_unverified');
  });

  it('instantané d’un autre plan, ou illisible : refusé (422), jamais une erreur interne', async () => {
    const a = await seedPlan(manager);
    const b = await seedPlan(manager);
    const rev = await frozen(a.doc, 'X');
    const wrongPlan = { ...rev.meta, planId: b.doc.plan.id };
    const r = await manager.req('PUT', `/api/revisions/${rev.meta.id}`, {
      body: { planId: b.doc.plan.id, meta: wrongPlan, snapshot: rev.json },
    });
    expect(r.statusCode).toBe(422);
  });

  it('deux révisions de même libellé envoyées en même temps : une seule acceptée', async () => {
    const { doc } = await seedPlan(manager);
    const one = await frozen(doc, 'Z');
    const two = await freezeRevision(
      doc,
      {
        label: 'Z',
        description: '',
        author: 'M. Gagnon',
        date: '2026-10-01',
        reason: '',
        comments: '',
        status: 'review',
      },
      { id: newId(), existingLabels: [], parentId: null, changes: null, now: new Date().toISOString() },
    );
    const send = (r: typeof one) =>
      manager.req('PUT', `/api/revisions/${r.meta.id}`, {
        body: { planId: doc.plan.id, meta: r.meta, snapshot: r.json },
      });
    const codes = (await Promise.all([send(one), send(two)])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409]);
  });
});

describe('invitations : pas de devinette de mot de passe', () => {
  it('5 mots de passe faux sur un compte existant : invitation annulée', async () => {
    const adminB = await h.login('admin@autre.test');
    const { token } = (
      await adminB.req('POST', '/api/invitations', { body: { email: 'lecture@pamm.test', role: 'reader' } })
    ).json();
    for (let i = 0; i < 5; i++)
      expect(
        (
          await h.anonymous.req('POST', `/api/invitations/${token}/accept`, {
            body: { password: `faux-${i}` },
          })
        ).statusCode,
      ).toBe(401);
    const last = await h.anonymous.req('POST', `/api/invitations/${token}/accept`, {
      body: { password: PASSWORD },
    });
    expect(last.statusCode).toBe(404);
    // Le titulaire n'est pas bloqué pour autant.
    await h.login('lecture@pamm.test');
  });
});

describe('restriction par camp : fichiers', () => {
  it('éditeur limité à un camp : la photo d’un autre camp est inaccessible', async () => {
    const mine = await seedPlan(manager);
    const other = await seedPlan(manager);
    await h.db.owner.query(
      'INSERT INTO camp_access (organization_id, camp_id, user_id) VALUES ($1, $2, $3)',
      [h.orgA.id, mine.site.id, h.users.editorA.id],
    );
    expect((await editor.req('GET', `/api/files/${sha256(mine.photo)}`)).statusCode).toBe(200);
    expect((await editor.req('GET', `/api/files/${sha256(other.photo)}`)).statusCode).toBe(404);
    expect((await manager.req('GET', `/api/files/${sha256(other.photo)}`)).statusCode).toBe(200);
    await h.db.owner.query('DELETE FROM camp_access WHERE user_id = $1', [h.users.editorA.id]);
  });
});

describe('démarrage', () => {
  it('rôle qui contourne la RLS (propriétaire superutilisateur) : refusé ; rôle applicatif : accepté', async () => {
    await expect(assertRowSecurityApplies(h.db.owner)).rejects.toThrow(/contourne la sécurité/);
    await expect(assertRowSecurityApplies(h.db.pool)).resolves.toBeUndefined();
    // Même pool applicatif : toujours isolé par la transaction.
    const seen = await tx(h.db.pool, { orgId: h.orgB.id, userId: null }, (c) =>
      c.query('SELECT 1 FROM plans'),
    );
    expect(seen.rowCount).toBe(0);
  });
});
