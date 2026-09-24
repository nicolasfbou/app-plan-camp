/**
 * Revue indépendante 9.1 : défauts confirmés, reproduits puis corrigés.
 * - deux administrateurs qui se retirent mutuellement le rôle en même temps ;
 * - révision envoyée pour un plan supprimé ;
 * - fichier d'un camp hors de portée cité par un éditeur limité à un autre camp ;
 * - écriture préparée avant une restauration du serveur (génération) ;
 * - nettoyage des fichiers et envoi du même fichier en même temps.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockFile, purgeUnusedFiles } from '../src/files/purge.ts';
import type { ObjectStorage } from '../src/storage/storage.ts';
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
let admin: ApiClient;
let manager: ApiClient;
beforeAll(async () => {
  h = await createHarness();
  admin = await h.login('admin@pamm.test');
  manager = await h.login('gestion@pamm.test');
});
afterAll(() => h.close());

describe('administrateurs', () => {
  it('deux administrateurs se retirent le rôle EN MÊME TEMPS : l’organisation garde un administrateur', async () => {
    const other = h.users.managerA.id;
    expect((await admin.req('PATCH', `/api/members/${other}`, { body: { role: 'admin' } })).statusCode).toBe(
      200,
    );
    const second = await h.login('gestion@pamm.test');
    // Point de synchronisation : les deux requêtes passent l'authentification (deux
    // administrateurs actifs), puis attendent le verrou des membres retenu ici.
    const holder = await h.db.owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`members:${h.orgA.id}`]);
      const both = Promise.all([
        admin.req('PATCH', `/api/members/${other}`, { body: { role: 'editor' } }),
        second.req('PATCH', `/api/members/${h.users.adminA.id}`, { body: { role: 'editor' } }),
      ]);
      await expect
        .poll(async () => {
          const waiting = await h.db.owner.query(
            "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
          );
          return waiting.rows[0].n;
        })
        .toBe(2);
      await holder.query('COMMIT');
      const [a, b] = await both;
      // Changements sérialisés : l'un réussit, l'autre voit qu'il ne reste qu'un administrateur.
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      const admins = await h.db.owner.query(
        "SELECT count(*)::int AS n FROM memberships WHERE organization_id = $1 AND role = 'admin' AND status = 'active'",
        [h.orgA.id],
      );
      expect(admins.rows[0].n).toBe(1);
    } finally {
      holder.release();
      // État d'origine rétabli pour la suite.
      await h.db.owner.query(
        "UPDATE memberships SET role = CASE WHEN user_id = $2 THEN 'admin' ELSE 'manager' END WHERE organization_id = $1 AND user_id IN ($2, $3)",
        [h.orgA.id, h.users.adminA.id, other],
      );
    }
  });
});

describe('révisions', () => {
  it('révision envoyée pour un plan supprimé sur le serveur : refusée (409), rien d’écrit', async () => {
    const { doc } = await seedPlan(manager);
    expect(
      (await manager.req('DELETE', `/api/plans/${doc.plan.id}`, { headers: { 'if-match': '1' } })).statusCode,
    ).toBe(200);
    const rev = await frozen(doc, 'A');
    const r = await manager.req('PUT', `/api/revisions/${rev.meta.id}`, {
      body: { planId: doc.plan.id, meta: rev.meta, snapshot: rev.json },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('plan-deleted');
    const rows = await h.db.owner.query('SELECT 1 FROM revisions WHERE id = $1', [rev.meta.id]);
    expect(rows.rowCount).toBe(0);
  });
});

describe('restriction par camp : références de fichiers', () => {
  it('un éditeur limité à un camp ne peut pas citer (ni voir) la photo d’un autre camp par son empreinte', async () => {
    const editor = await h.login('edition@pamm.test');
    const mine = await seedPlan(manager, 'Mon camp');
    const other = await seedPlan(manager, 'Autre camp');
    const foreign = sha256(other.photo);
    await h.db.owner.query(
      'INSERT INTO camp_access (organization_id, camp_id, user_id) VALUES ($1, $2, $3)',
      [h.orgA.id, mine.site.id, h.users.editorA.id],
    );
    try {
      // Hors de portée = absent (jamais « présent » ni 403 qui révélerait son existence).
      const check = await editor.req('POST', '/api/files/check', {
        body: { sha256: [foreign, sha256(mine.photo)] },
      });
      expect(check.json().present).toEqual([sha256(mine.photo)]);
      const doc = structuredClone(mine.doc);
      doc.plan.baseImage = { ...doc.plan.baseImage!, sha256: foreign, byteLength: other.photo.length };
      const cited = await putPlan(editor, doc, mine.version);
      expect(cited.statusCode).toBe(422);
      expect(cited.json().missing).toEqual([foreign]);
      expect((await editor.req('GET', `/api/files/${foreign}`)).statusCode).toBe(404);
      // La personne qui POSSÈDE les octets (envoi identique, dédoublonné) peut les citer.
      const upload = await uploadFile(editor, other.photo);
      expect(upload.statusCode).toBe(200);
      expect(upload.json().created).toBe(false);
      expect((await putPlan(editor, doc, mine.version)).statusCode).toBe(200);
      expect((await editor.req('GET', `/api/files/${foreign}`)).statusCode).toBe(200);
    } finally {
      await h.db.owner.query('DELETE FROM camp_access WHERE user_id = $1', [h.users.editorA.id]);
    }
  });
});

describe('génération du serveur', () => {
  it('écriture préparée avant une restauration : refusée (409 generation) ; lecture et écriture à jour acceptées', async () => {
    const { doc, version } = await seedPlan(manager);
    const sync = (await manager.req('GET', '/api/sync/changes?since=0')).json();
    const known = sync.generation as string;
    expect(known).toMatch(/.+/);
    await h.db.owner.query("UPDATE server_meta SET value = gen_random_uuid()::text WHERE key = 'generation'");
    const next = structuredClone(doc);
    next.plan.titleBlock.notes = 'préparé avant la restauration';
    const stale = await manager.req('PUT', `/api/plans/${doc.plan.id}`, {
      body: { campId: doc.plan.siteId, document: next },
      headers: { 'if-match': String(version), 'x-server-generation': known },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('generation');
    expect((await manager.req('GET', `/api/plans/${doc.plan.id}`)).statusCode).toBe(200);
    const fresh = (await manager.req('GET', '/api/sync/changes?since=0')).json().generation as string;
    expect(fresh).not.toBe(known);
    const ok = await manager.req('PUT', `/api/plans/${doc.plan.id}`, {
      body: { campId: doc.plan.siteId, document: next },
      headers: { 'if-match': String(version), 'x-server-generation': fresh },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('nettoyage des fichiers', () => {
  it('nettoyage et envoi du même fichier sérialisés (verrou par fichier)', async () => {
    const bytes = jpeg(8192);
    const sha = sha256(bytes);
    expect((await uploadFile(manager, bytes)).statusCode).toBe(201);
    await h.db.owner.query("UPDATE files SET created_at = now() - interval '2 days' WHERE sha256 = $1", [
      sha,
    ]);
    // Un envoi du même fichier « en cours » tient le verrou : le nettoyage attend.
    const holder = await h.db.owner.connect();
    await holder.query('BEGIN');
    await lockFile(holder, h.orgA.id, sha);
    let finished = false;
    const purge = purgeUnusedFiles(h.db.owner, h.storage, { graceHours: 24 }).then((r) => {
      finished = true;
      return r;
    });
    await expect
      .poll(async () => {
        const waiting = await h.db.owner.query(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
        );
        return waiting.rows[0].n;
      })
      .toBe(1);
    expect(finished).toBe(false);
    await holder.query('COMMIT');
    holder.release();
    expect((await purge).removed.map((r) => r.sha256)).toContain(sha);
  });

  it('suppression de l’objet impossible : la ligne est conservée (jamais une ligne sans objet)', async () => {
    const bytes = jpeg(8192);
    const sha = sha256(bytes);
    expect((await uploadFile(manager, bytes)).statusCode).toBe(201);
    await h.db.owner.query("UPDATE files SET created_at = now() - interval '2 days' WHERE sha256 = $1", [
      sha,
    ]);
    const failing: ObjectStorage = Object.assign(Object.create(h.storage) as ObjectStorage, {
      delete: async () => {
        throw new Error('stockage indisponible');
      },
    });
    const r = await purgeUnusedFiles(h.db.owner, failing, { graceHours: 24 });
    expect(r.errors.join()).toMatch(/stockage indisponible/);
    const row = await h.db.owner.query('SELECT 1 FROM files WHERE sha256 = $1', [sha]);
    expect(row.rowCount).toBe(1);
    expect((await manager.req('GET', `/api/files/${sha}`)).statusCode).toBe(200);
  });
});
