/**
 * Administration (phase 9.1) : invitations (liste, révocation, renvoi, expiration), comptes de
 * l'organisation (désactivation, réactivation, rôle), sessions invalidées côté serveur même
 * dans un AUTRE navigateur, journal d'audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiClient, createHarness, type Harness, PASSWORD, seedPlan } from './harness.ts';

let h: Harness;
let admin: ApiClient;
beforeAll(async () => {
  h = await createHarness();
  admin = await h.login('admin@pamm.test');
});
afterAll(() => h.close());

const accept = (token: string, body: Record<string, string>) =>
  h.anonymous.req('POST', `/api/invitations/${token}/accept`, { body });
const auditActions = async () =>
  (
    (await admin.req('GET', '/api/audit?limit=500')).json().events as { action: string; targetId: string }[]
  ).map((e) => `${e.action}:${e.targetId}`);

describe('invitations', () => {
  it('liste des invitations en attente ; réservée à l’administrateur', async () => {
    const r = await admin.req('POST', '/api/invitations', {
      body: { email: 'liste@pamm.test', role: 'reader' },
    });
    expect(r.statusCode).toBe(200);
    const list = (await admin.req('GET', '/api/invitations')).json().invitations as {
      id: string;
      email: string;
      status: string;
      invitedBy: string;
    }[];
    expect(list.find((i) => i.id === r.json().id)).toMatchObject({
      email: 'liste@pamm.test',
      status: 'pending',
      invitedBy: 'Admin PAMM',
    });
    const manager = await h.login('gestion@pamm.test');
    expect((await manager.req('GET', '/api/invitations')).statusCode).toBe(403);
    expect((await manager.req('DELETE', `/api/invitations/${r.json().id}`)).statusCode).toBe(403);
    // Autre organisation : invisible, non révocable.
    const adminB = await h.login('admin@autre.test');
    expect((await adminB.req('GET', '/api/invitations')).json().invitations).toEqual([]);
    expect((await adminB.req('DELETE', `/api/invitations/${r.json().id}`)).statusCode).toBe(404);
  });

  it('révocation : le lien est refusé par le serveur ; audit', async () => {
    const r = (
      await admin.req('POST', '/api/invitations', { body: { email: 'revoque@pamm.test', role: 'editor' } })
    ).json();
    expect((await admin.req('DELETE', `/api/invitations/${r.id}`)).statusCode).toBe(200);
    expect((await h.anonymous.req('GET', `/api/invitations/${r.token}`)).statusCode).toBe(404);
    expect((await accept(r.token, { displayName: 'X', password: PASSWORD })).statusCode).toBe(404);
    const list = (await admin.req('GET', '/api/invitations')).json().invitations as {
      id: string;
      status: string;
    }[];
    expect(list.find((i) => i.id === r.id)!.status).toBe('revoked');
    expect(await auditActions()).toContain(`member.invite.revoke:${r.id}`);
  });

  it('renvoi : nouveau jeton ; l’ancien lien est refusé, le nouveau fonctionne', async () => {
    const first = (
      await admin.req('POST', '/api/invitations', { body: { email: 'renvoi@pamm.test', role: 'editor' } })
    ).json();
    const again = await admin.req('POST', `/api/invitations/${first.id}/resend`);
    expect(again.statusCode).toBe(200);
    const second = again.json();
    expect(second.token).not.toBe(first.token);
    expect((await accept(first.token, { displayName: 'R', password: PASSWORD })).statusCode).toBe(404);
    expect((await accept(second.token, { displayName: 'R', password: PASSWORD })).statusCode).toBe(200);
    expect(await auditActions()).toContain(`member.invite.resend:${second.id}`);
  });

  it('invitation expirée : refusée par le serveur', async () => {
    const r = (
      await admin.req('POST', '/api/invitations', { body: { email: 'expire@pamm.test', role: 'reader' } })
    ).json();
    await h.db.owner.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      r.id,
    ]);
    expect((await accept(r.token, { displayName: 'E', password: PASSWORD })).statusCode).toBe(404);
    const list = (await admin.req('GET', '/api/invitations')).json().invitations as {
      id: string;
      status: string;
    }[];
    expect(list.find((i) => i.id === r.id)!.status).toBe('expired');
  });

  it('limitation des tentatives par invitation : 5 mots de passe faux → invitation bloquée (audit), bonne réponse ensuite refusée', async () => {
    const adminB = await h.login('admin@autre.test');
    const r = (
      await adminB.req('POST', '/api/invitations', { body: { email: 'edition@pamm.test', role: 'reader' } })
    ).json();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await accept(r.token, { password: `mauvais-${i}` })).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(404); // bloquée : même avec le bon mot de passe ensuite
    expect((await accept(r.token, { password: PASSWORD })).statusCode).toBe(404);
    const eventsB = (await adminB.req('GET', '/api/audit?limit=100')).json().events as {
      action: string;
      targetId: string;
    }[];
    expect(eventsB.some((e) => e.action === 'member.invite.locked' && e.targetId === r.id)).toBe(true);
    // Le titulaire du compte n'est pas bloqué (limitation par compte ET adresse, pas globale).
    await h.login('edition@pamm.test');
  });
});

describe('comptes de l’organisation', () => {
  it('désactivation : toutes ses sessions (deux navigateurs) refusées immédiatement ; réactivation : nouvelle connexion requise', async () => {
    const browser1 = await h.login('lecture@pamm.test');
    const browser2 = await h.login('lecture@pamm.test', 'shared');
    expect((await browser1.req('GET', '/api/plans')).statusCode).toBe(200);
    expect((await browser2.req('GET', '/api/plans')).statusCode).toBe(200);
    const id = h.users.readerA.id;
    expect(
      (await admin.req('PATCH', `/api/members/${id}`, { body: { status: 'disabled' } })).statusCode,
    ).toBe(200);
    for (const b of [browser1, browser2]) {
      expect((await b.req('GET', '/api/plans')).statusCode).toBe(401);
      expect((await b.req('GET', '/api/auth/me')).statusCode).toBe(401);
    }
    // Ni connexion, ni session : l'accès est coupé.
    const login = await h.anonymous.req('POST', '/api/auth/login', {
      body: { email: 'lecture@pamm.test', password: PASSWORD, deviceMode: 'trusted' },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json().error).toBe('no-organization');
    const members = (await admin.req('GET', '/api/members')).json().members as {
      id: string;
      status: string;
    }[];
    expect(members.find((m) => m.id === id)!.status).toBe('disabled');
    // Réactivation : les anciennes sessions restent invalides ; une nouvelle connexion fonctionne.
    expect((await admin.req('PATCH', `/api/members/${id}`, { body: { status: 'active' } })).statusCode).toBe(
      200,
    );
    expect((await browser1.req('GET', '/api/plans')).statusCode).toBe(401);
    const fresh = await h.login('lecture@pamm.test');
    expect((await fresh.req('GET', '/api/plans')).statusCode).toBe(200);
    const actions = await auditActions();
    expect(actions).toContain(`member.disable:${id}`);
    expect(actions).toContain(`member.enable:${id}`);
  });

  it('changement de rôle : effectif dès la requête suivante de la session existante ; audit', async () => {
    const editor = await h.login('edition@pamm.test');
    const manager = await h.login('gestion@pamm.test');
    const { doc } = await seedPlan(manager);
    const id = h.users.editorA.id;
    expect((await editor.req('GET', `/api/plans/${doc.plan.id}`)).statusCode).toBe(200);
    expect((await admin.req('PATCH', `/api/members/${id}`, { body: { role: 'reader' } })).statusCode).toBe(
      200,
    );
    expect((await editor.req('GET', '/api/auth/me')).json().role).toBe('reader');
    const write = await editor.req('PUT', `/api/plans/${doc.plan.id}`, {
      body: { campId: doc.plan.siteId, document: doc },
      headers: { 'if-match': '1' },
    });
    expect(write.statusCode).toBe(403);
    expect(await auditActions()).toContain(`member.role:${id}`);
    await admin.req('PATCH', `/api/members/${id}`, { body: { role: 'editor' } });
  });

  it('dernier administrateur protégé ; un non-administrateur ne peut rien modifier', async () => {
    const r = await admin.req('PATCH', `/api/members/${h.users.adminA.id}`, { body: { status: 'disabled' } });
    expect(r.statusCode).toBe(409);
    const manager = await h.login('gestion@pamm.test');
    expect(
      (await manager.req('PATCH', `/api/members/${h.users.editorA.id}`, { body: { role: 'admin' } }))
        .statusCode,
    ).toBe(403);
  });
});

describe('période d’accès', () => {
  it('opération d’une période révoquée : refusée par le serveur même avec une nouvelle session valide', async () => {
    const manager = await h.login('gestion@pamm.test');
    const { doc } = await seedPlan(manager);
    const before = (await manager.req('GET', '/api/auth/me')).json().accessEpoch as number;
    const id = h.users.managerA.id;
    await admin.req('PATCH', `/api/members/${id}`, { body: { status: 'disabled' } });
    await admin.req('PATCH', `/api/members/${id}`, { body: { status: 'active' } });
    const again = await h.login('gestion@pamm.test');
    expect((await again.req('GET', '/api/auth/me')).json().accessEpoch).toBe(before + 1);
    const next = structuredClone(doc);
    next.plan.titleBlock.notes = 'fait pendant la révocation';
    const old = await again.req('PUT', `/api/plans/${doc.plan.id}`, {
      body: { campId: doc.plan.siteId, document: next },
      headers: { 'if-match': '1', 'x-operation-epoch': String(before) },
    });
    expect(old.statusCode).toBe(409);
    expect(old.json().error).toBe('access-revoked-operation');
    const current = await again.req('PUT', `/api/plans/${doc.plan.id}`, {
      body: { campId: doc.plan.siteId, document: next },
      headers: { 'if-match': '1', 'x-operation-epoch': String(before + 1) },
    });
    expect(current.statusCode).toBe(200);
  });
});
