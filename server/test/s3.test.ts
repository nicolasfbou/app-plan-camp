/**
 * Intégration avec un VRAI service compatible S3 (phase 9.1). Exécuté uniquement si un service
 * est fourni ; sinon ignoré (et signalé comme tel : aucune prétention de test réel).
 *
 *   S3_TEST_ENDPOINT=http://127.0.0.1:8333 S3_TEST_REGION=us-east-1 \
 *   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… npx vitest run --project server server/test/s3.test.ts
 *
 * Voir docs/OPERATIONS.md (« Test S3 ») pour lancer un service isolé (SeaweedFS, MinIO…).
 * Chaque exécution crée son propre compartiment et le vide à la fin.
 */
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlanDocument } from '@/domain/model/factories.ts';
import { purgeUnusedFiles } from '../src/files/purge.ts';
import { S3Storage } from '../src/storage/s3Storage.ts';
import { fileKey } from '../src/storage/storage.ts';
import {
  type ApiClient,
  createHarness,
  type Harness,
  jpeg,
  PASSWORD,
  putPlan,
  seedPlan,
  sha256,
  uploadFile,
} from './harness.ts';

const endpoint = process.env.S3_TEST_ENDPOINT;
const region = process.env.S3_TEST_REGION ?? 'us-east-1';
const bucket = `campplanner-test-${randomBytes(4).toString('hex')}`;

describe.skipIf(!endpoint)(`stockage S3 réel (${endpoint ?? 'non configuré : S3_TEST_ENDPOINT'})`, () => {
  let h: Harness;
  let s3: S3Client;
  let manager: ApiClient, adminB: ApiClient, editor: ApiClient;
  const objectKey = (orgId: string, sha: string) => fileKey(orgId, sha);
  const head = async (key: string) =>
    s3
      .send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      .then((r) => r.ContentLength ?? -1)
      .catch(() => null);

  beforeAll(async () => {
    s3 = new S3Client({ region, endpoint, forcePathStyle: true });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const storage = new S3Storage({
      driver: 's3',
      bucket,
      region,
      endpoint,
      forcePathStyle: true,
      prefix: '',
    });
    h = await createHarness({ MAX_UPLOAD_BYTES: String(100 * 1024 * 1024) }, { storage });
    manager = await h.login('gestion@pamm.test');
    editor = await h.login('edition@pamm.test');
    adminB = await h.login('admin@autre.test');
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    for (;;) {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
      if (!list.Contents?.length) break;
      for (const o of list.Contents) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key! }));
    }
    await s3.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
  }, 60_000);

  it('envoi puis téléchargement : objet dans le compartiment, octets et SHA-256 identiques', async () => {
    const photo = jpeg(256 * 1024);
    expect((await uploadFile(manager, photo)).statusCode).toBe(201);
    expect(await head(objectKey(h.orgA.id, sha256(photo)))).toBe(photo.length);
    const back = await manager.req('GET', `/api/files/${sha256(photo)}`);
    expect(back.statusCode).toBe(200);
    expect(sha256(back.rawPayload)).toBe(sha256(photo));
    // Renvoi identique : idempotent, aucun second objet.
    expect((await uploadFile(manager, photo)).statusCode).toBe(200);
  });

  it('SHA-256 annoncé faux : refusé, rien écrit dans le compartiment', async () => {
    const photo = jpeg(64 * 1024);
    const lie = sha256(jpeg(10));
    const r = await manager.req('PUT', `/api/files/${lie}`, {
      raw: photo,
      headers: { 'x-file-type': 'image/jpeg' },
    });
    expect(r.statusCode).toBe(422);
    expect(await head(objectKey(h.orgA.id, lie))).toBeNull();
    expect(await head(objectKey(h.orgA.id, sha256(photo)))).toBeNull();
  });

  it('fichier partagé entre deux plans ; suppression d’un plan ; fichier encore utilisé protégé du nettoyage', async () => {
    const first = await seedPlan(manager);
    const doc2 = createPlanDocument({ siteId: first.site.id, name: 'Variante' });
    doc2.plan.baseImage = { ...first.doc.plan.baseImage! };
    expect((await putPlan(manager, doc2, 0)).statusCode).toBe(201);
    const sha = sha256(first.photo);
    const refs = await h.db.owner.query(
      "SELECT owner_id FROM file_refs WHERE sha256 = $1 AND owner_kind = 'plan' ORDER BY owner_id",
      [sha],
    );
    expect(refs.rows.map((r) => r.owner_id).sort()).toEqual([first.doc.plan.id, doc2.plan.id].sort());
    // Suppression (logique) du premier plan : le fichier reste lisible (historique, restauration).
    expect(
      (await manager.req('DELETE', `/api/plans/${first.doc.plan.id}`, { headers: { 'if-match': '1' } }))
        .statusCode,
    ).toBe(200);
    expect((await manager.req('GET', `/api/files/${sha}`)).statusCode).toBe(200);
    // Un fichier jamais référencé (envoi abandonné) : supprimé par le nettoyage ; le fichier
    // utilisé (même par un plan supprimé) : conservé.
    const orphan = jpeg(32 * 1024);
    await uploadFile(manager, orphan);
    await h.db.owner.query("UPDATE files SET created_at = now() - interval '2 days'");
    const purge = await purgeUnusedFiles(h.db.owner, h.storage, { graceHours: 24 });
    expect(purge.errors).toEqual([]);
    expect(purge.removed.map((r) => r.sha256)).toContain(sha256(orphan));
    expect(purge.removed.map((r) => r.sha256)).not.toContain(sha);
    expect(await head(objectKey(h.orgA.id, sha256(orphan)))).toBeNull();
    expect(await head(objectKey(h.orgA.id, sha))).toBe(first.photo.length);
    expect((await manager.req('GET', `/api/files/${sha}`)).statusCode).toBe(200);
    const audit = await h.db.owner.query("SELECT target_id FROM audit_events WHERE action = 'file.purge'");
    expect(audit.rows.map((r) => r.target_id)).toContain(sha256(orphan));
  });

  it('envoi interrompu en plein flux : aucun objet, aucune ligne', async () => {
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = h.app.server.address() as AddressInfo;
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-campplanner': '1' },
      payload: { email: 'gestion@pamm.test', password: PASSWORD, deviceMode: 'trusted' },
    });
    const cookie = `cp_session=${login.cookies.find((c) => c.name === 'cp_session')!.value}`;
    const photo = jpeg(4 * 1024 * 1024);
    const sha = sha256(photo);
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: `/api/files/${sha}`,
        headers: {
          cookie,
          'x-campplanner': '1',
          'x-file-type': 'image/jpeg',
          'content-type': 'application/octet-stream',
          'content-length': String(photo.length),
        },
      });
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.write(photo.subarray(0, 1024 * 1024), () => setTimeout(() => req.destroy(), 100));
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(await head(objectKey(h.orgA.id, sha))).toBeNull();
    const rows = await h.db.owner.query('SELECT 1 FROM files WHERE sha256 = $1', [sha]);
    expect(rows.rowCount).toBe(0);
    // Nouvel essai complet : accepté.
    expect((await uploadFile(manager, photo)).statusCode).toBe(201);
    expect(await head(objectKey(h.orgA.id, sha))).toBe(photo.length);
  }, 60_000);

  it('fichier volumineux (60 Mo) : envoi en flux, téléchargement, SHA-256 identique', async () => {
    const big = jpeg(60 * 1024 * 1024);
    const up = await uploadFile(manager, big);
    expect(up.statusCode).toBe(201);
    expect(await head(objectKey(h.orgA.id, sha256(big)))).toBe(big.length);
    const back = await manager.req('GET', `/api/files/${sha256(big)}`);
    expect(back.rawPayload.length).toBe(big.length);
    expect(sha256(back.rawPayload)).toBe(sha256(big));
  }, 180_000);

  it('accès refusé entre organisations ; même contenu envoyé par B = objet distinct sous le préfixe de B', async () => {
    const { photo } = await seedPlan(manager);
    const sha = sha256(photo);
    expect((await adminB.req('GET', `/api/files/${sha}`)).statusCode).toBe(404);
    expect((await uploadFile(adminB, photo)).statusCode).toBe(201);
    expect(await head(objectKey(h.orgB.id, sha))).toBe(photo.length);
    expect(objectKey(h.orgB.id, sha)).not.toBe(objectKey(h.orgA.id, sha));
  });

  it('accès refusé entre camps (éditeur limité à un camp)', async () => {
    const mine = await seedPlan(manager);
    const other = await seedPlan(manager);
    await h.db.owner.query(
      'INSERT INTO camp_access (organization_id, camp_id, user_id) VALUES ($1, $2, $3)',
      [h.orgA.id, mine.site.id, h.users.editorA.id],
    );
    expect((await editor.req('GET', `/api/files/${sha256(mine.photo)}`)).statusCode).toBe(200);
    expect((await editor.req('GET', `/api/files/${sha256(other.photo)}`)).statusCode).toBe(404);
    await h.db.owner.query('DELETE FROM camp_access WHERE user_id = $1', [h.users.editorA.id]);
  });
});
