import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, PASSWORD } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('authentification', () => {
  it('connexion : session en cookie HttpOnly SameSite=Strict ; mot de passe jamais stocké en clair', async () => {
    const r = await h.anonymous.req('POST', '/api/auth/login', {
      body: { email: 'edition@pamm.test', password: PASSWORD, deviceMode: 'trusted' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ role: 'editor', organization: { slug: 'pamm' }, deviceMode: 'trusted' });
    const cookie = r.cookies.find((c) => c.name === 'cp_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api' });
    expect(cookie.expires).toBeDefined(); // appareil de confiance : cookie persistant
    const stored = await h.db.owner.query('SELECT secret_hash FROM user_identities');
    for (const row of stored.rows) {
      expect(row.secret_hash).toMatch(/^\$argon2id\$/);
      expect(row.secret_hash).not.toContain(PASSWORD);
    }
    const sessions = await h.db.owner.query('SELECT id_hash FROM sessions');
    expect(sessions.rows.map((s) => s.id_hash)).not.toContain(cookie.value); // jeton stocké haché
  });

  it('appareil partagé : cookie de session (non persistant)', async () => {
    const r = await h.anonymous.req('POST', '/api/auth/login', {
      body: { email: 'edition@pamm.test', password: PASSWORD, deviceMode: 'shared' },
    });
    expect(r.cookies.find((c) => c.name === 'cp_session')!.expires).toBeUndefined();
  });

  it('échec : même réponse pour un compte inconnu et un mauvais mot de passe', async () => {
    const unknown = await h.anonymous.req('POST', '/api/auth/login', {
      body: { email: 'inconnu@pamm.test', password: 'x', deviceMode: 'trusted' },
    });
    const wrong = await h.anonymous.req('POST', '/api/auth/login', {
      body: { email: 'lecture@pamm.test', password: 'mauvais', deviceMode: 'trusted' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it('sans session : 401 ; sans en-tête anti-CSRF : 403', async () => {
    expect((await h.anonymous.req('GET', '/api/camps')).statusCode).toBe(401);
    const api = await h.login('admin@pamm.test');
    const r = await h.app.inject({
      method: 'PUT',
      url: '/api/camps/camp-csrf-1',
      headers: { cookie: api.cookie, 'if-match': '0' },
      payload: { name: 'X' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('csrf');
  });

  it('déconnexion : la session est révoquée côté serveur', async () => {
    const api = await h.login('lecture@pamm.test');
    expect((await api.req('GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await api.req('POST', '/api/auth/logout')).statusCode).toBe(200);
    expect((await api.req('GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('limitation des tentatives', async () => {
    let last = 0;
    for (let i = 0; i < 10; i++)
      last = (
        await h.anonymous.req('POST', '/api/auth/login', {
          body: { email: 'gestion@pamm.test', password: `faux-${i}`, deviceMode: 'trusted' },
        })
      ).statusCode;
    expect(last).toBe(429);
  });
});

describe('invitations et membres', () => {
  it('invitation par un administrateur ; lien à usage unique ; nouveau compte', async () => {
    const admin = await h.login('admin@pamm.test');
    const editor = await h.login('edition@pamm.test');
    expect(
      (await editor.req('POST', '/api/invitations', { body: { email: 'x@pamm.test', role: 'reader' } }))
        .statusCode,
    ).toBe(403);
    const inv = await admin.req('POST', '/api/invitations', {
      body: { email: 'nouveau@pamm.test', role: 'editor' },
    });
    expect(inv.statusCode).toBe(200);
    const { token } = inv.json();
    const info = await h.anonymous.req('GET', `/api/invitations/${token}`);
    expect(info.json()).toMatchObject({
      organization: 'PAMM',
      email: 'nouveau@pamm.test',
      existingAccount: false,
    });
    expect(
      (
        await h.anonymous.req('POST', `/api/invitations/${token}/accept`, {
          body: { displayName: 'Nouveau', password: 'court' },
        })
      ).statusCode,
    ).toBe(400);
    const ok = await h.anonymous.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'Nouveau', password: PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    expect(
      (await h.anonymous.req('POST', `/api/invitations/${token}/accept`, { body: { password: PASSWORD } }))
        .statusCode,
    ).toBe(404);
    const me = await h.login('nouveau@pamm.test');
    expect((await me.req('GET', '/api/auth/me')).json().role).toBe('editor');
  });

  it('compte existant invité dans une autre organisation : même utilisateur, pas de doublon', async () => {
    const adminB = await h.login('admin@autre.test');
    const { token } = (
      await adminB.req('POST', '/api/invitations', { body: { email: 'edition@pamm.test', role: 'reader' } })
    ).json();
    expect(
      (
        await h.anonymous.req('POST', `/api/invitations/${token}/accept`, {
          body: { password: 'mauvais-mot-de-passe' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await h.anonymous.req('POST', `/api/invitations/${token}/accept`, { body: { password: PASSWORD } }))
        .statusCode,
    ).toBe(200);
    const count = await h.db.owner.query(
      "SELECT count(*)::int AS n FROM users WHERE email = 'edition@pamm.test'",
    );
    expect(count.rows[0].n).toBe(1);
    // Deux organisations : il faut choisir à la connexion.
    const r = await h.anonymous.req('POST', '/api/auth/login', {
      body: { email: 'edition@pamm.test', password: PASSWORD, deviceMode: 'trusted' },
    });
    expect(r.statusCode).toBe(409);
    expect(
      r
        .json()
        .organizations.map((o: { slug: string }) => o.slug)
        .sort(),
    ).toEqual(['autre', 'pamm']);
  });

  it('accès suspendu : sessions révoquées ; dernier administrateur protégé', async () => {
    const admin = await h.login('admin@pamm.test');
    const reader = await h.login('lecture@pamm.test');
    expect(
      (await admin.req('PATCH', `/api/members/${h.users.readerA.id}`, { body: { status: 'disabled' } }))
        .statusCode,
    ).toBe(200);
    expect((await reader.req('GET', '/api/auth/me')).statusCode).toBe(401);
    expect(
      (await admin.req('PATCH', `/api/members/${h.users.adminA.id}`, { body: { role: 'reader' } })).json()
        .error,
    ).toBe('last-admin');
    await admin.req('PATCH', `/api/members/${h.users.readerA.id}`, { body: { status: 'active' } });
    // Un admin de B ne peut pas toucher un membre de A.
    const adminB = await h.login('admin@autre.test');
    expect(
      (await adminB.req('PATCH', `/api/members/${h.users.readerA.id}`, { body: { role: 'admin' } }))
        .statusCode,
    ).toBe(404);
  });
});
