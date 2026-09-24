/**
 * Sauvegarde et restauration COMPLÈTES (phase 9.1) : base + photos + PDF + pictogrammes + logos
 * de modèles + révisions (dont approuvée) + audit, restaurées sur une INFRASTRUCTURE DE TEST
 * ISOLÉE (second serveur PostgreSQL, second stockage de fichiers), puis vérifiées : comptes,
 * organisations, camps, plans, révisions, approbations, audit, SHA-256 des fichiers, et
 * fonctionnement de l'API sur les données restaurées.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templateFromPlan } from '@/domain/templates/template.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db.ts';
import { backup, restore, verifyBackup } from '../src/ops/backup.ts';
import { FsStorage } from '../src/storage/fsStorage.ts';
import { S3Storage } from '../src/storage/s3Storage.ts';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import {
  client,
  createHarness,
  frozen,
  type Harness,
  PASSWORD,
  putPlan,
  seedPlan,
  sha256,
  uploadFile,
} from './harness.ts';
import { startCluster } from './pgCluster.ts';

const PG_BIN = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
let h: Harness;
let dir: string;
const png = (size: number) => {
  const b = randomBytes(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b;
};
const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" fill="#c00"/></svg>',
);
const logo = png(4096);
const expected: { photo: string; revisionApproved: string; planPdf: string } = {
  photo: '',
  revisionApproved: '',
  planPdf: '',
};

beforeAll(async () => {
  h = await createHarness();
  dir = mkdtempSync(join(tmpdir(), 'campplanner-backup-'));
  const manager = await h.login('gestion@pamm.test');
  const adminB = await h.login('admin@autre.test');
  // Plan avec photo, pictogramme SVG, révision APPROUVÉE (compte, date serveur).
  const plan = await seedPlan(manager);
  expected.photo = sha256(plan.photo);
  expect((await uploadFile(manager, svg, 'image/svg+xml')).statusCode).toBe(201);
  const doc = structuredClone(plan.doc);
  doc.assets['pictoRouge01'] = {
    id: 'pictoRouge01',
    name: 'Pictogramme rouge',
    blobId: 'blobPicto01',
    mimeType: 'image/svg+xml',
    byteLength: svg.length,
    sha256: sha256(svg),
    createdAt: new Date().toISOString(),
  };
  expect((await putPlan(manager, doc, 1)).statusCode).toBe(200);
  const rev = await frozen(doc, 'A');
  expect(
    (
      await manager.req('PUT', `/api/revisions/${rev.meta.id}`, {
        body: { planId: doc.plan.id, meta: rev.meta, snapshot: rev.json },
      })
    ).statusCode,
  ).toBe(201);
  const approve = await manager.req('POST', `/api/revisions/${rev.meta.id}/status`, {
    body: { to: 'approved', confirmed: true, comment: 'Approuvé pour essai de restauration' },
  });
  expect(approve.statusCode).toBe(200);
  expected.revisionApproved = rev.meta.id;
  // Plan issu d'un PDF (original conservé + page rastérisée PNG).
  const page = png(8192);
  expect((await uploadFile(manager, pdf, 'application/pdf')).statusCode).toBe(201);
  expect((await uploadFile(manager, page, 'image/png')).statusCode).toBe(201);
  const pdfPlan = await seedPlan(manager, 'Plan PDF');
  const pdfDoc = structuredClone(pdfPlan.doc);
  pdfDoc.plan.baseImage = {
    ...pdfDoc.plan.baseImage!,
    mimeType: 'image/png',
    byteLength: page.length,
    sha256: sha256(page),
    source: {
      kind: 'pdf',
      pdfBlobId: 'blobPdf0001',
      pdfFileName: 'plan.pdf',
      pdfByteLength: pdf.length,
      pdfSha256: sha256(pdf),
      pageCount: 1,
      page: 1,
      dpi: 150,
    },
  };
  expect((await putPlan(manager, pdfDoc, 1)).statusCode).toBe(200);
  expected.planPdf = pdfDoc.plan.id;
  // Modèle avec logo.
  expect((await uploadFile(manager, logo, 'image/png')).statusCode).toBe(201);
  const template = templateFromPlan(doc, 'Modèle PAMM', {
    logo: { name: 'logo.png', mimeType: 'image/png', sha256: sha256(logo), byteLength: logo.length },
  });
  expect(
    (
      await manager.req('PUT', `/api/templates/${template.id}`, {
        body: { template },
        headers: { 'if-match': '0' },
      })
    ).statusCode,
  ).toBe(201);
  // Données d'une seconde organisation.
  await seedPlan(adminB, 'Plan B');
}, 60_000);
afterAll(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sauvegarde complète et restauration isolée', () => {
  it('sauvegarde : base + tous les fichiers, vérifiables sans restaurer ; altération détectée', async () => {
    const manifest = await backup({
      databaseUrl: h.db.ownerUrl,
      storage: h.storage,
      outDir: dir,
      pgBin: PG_BIN,
    });
    expect(manifest.counts.organizations).toBe(2);
    expect(manifest.counts.revisions_approved).toBe(1);
    expect(manifest.files.map((f) => f.mimeType).sort()).toEqual(
      expect.arrayContaining(['application/pdf', 'image/jpeg', 'image/png', 'image/svg+xml']),
    );
    expect((await verifyBackup(dir)).files.length).toBe(manifest.files.length);
    // Un fichier altéré dans la sauvegarde est détecté avant toute restauration.
    const victim = join(dir, manifest.files[0]!.path);
    const original = await import('node:fs/promises').then((fs) => fs.readFile(victim));
    writeFileSync(victim, Buffer.concat([original, Buffer.from('x')]));
    await expect(verifyBackup(dir)).rejects.toThrow(/altéré/);
    writeFileSync(victim, original);
    await expect(verifyBackup(dir)).resolves.toBeTruthy();
  }, 60_000);

  it('restauration sur un SECOND serveur PostgreSQL et un second stockage : tout est identique ; l’API fonctionne', async () => {
    const cluster = startCluster(); // infrastructure de test isolée (autre instance, autre port)
    const filesRoot = mkdtempSync(join(tmpdir(), 'campplanner-restore-files-'));
    try {
      const admin = new pg.Client({ connectionString: cluster.adminUrl });
      await admin.connect();
      await admin.query('CREATE DATABASE campplanner_restauree');
      await admin.end();
      const ownerUrl = cluster.adminUrl.replace(/\/postgres$/, '/campplanner_restauree');
      const storage = new FsStorage(filesRoot);
      const report = await restore({ fromDir: dir, databaseUrl: ownerUrl, storage, pgBin: PG_BIN });
      expect(report.mismatches).toEqual([]);
      expect(report.counts).toEqual(report.manifest.counts);
      // Restauration refusée par-dessus une base non vide.
      await expect(restore({ fromDir: dir, databaseUrl: ownerUrl, storage, pgBin: PG_BIN })).rejects.toThrow(
        /pas vide/,
      );
      // L'application tourne sur les données restaurées (rôle applicatif, RLS active).
      const appUrl = new URL(ownerUrl);
      appUrl.username = 'campplanner_app';
      const pool = createPool(appUrl.toString());
      const app = await buildApp({
        config: loadConfig({ DATABASE_URL: appUrl.toString(), STORAGE_FS_ROOT: filesRoot }),
        pool,
        storage,
      });
      try {
        const login = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-campplanner': '1' },
          payload: { email: 'gestion@pamm.test', password: PASSWORD, deviceMode: 'trusted' },
        });
        expect(login.statusCode).toBe(200); // comptes et mots de passe (hachés) restaurés
        const api = client(app, `cp_session=${login.cookies.find((c) => c.name === 'cp_session')!.value}`);
        const photo = await api.req('GET', `/api/files/${expected.photo}`);
        expect(sha256(photo.rawPayload)).toBe(expected.photo);
        const pdfPlan = (await api.req('GET', `/api/plans/${expected.planPdf}`)).json();
        const pdfBytes = await api.req(
          'GET',
          `/api/files/${pdfPlan.document.plan.baseImage.source.pdfSha256}`,
        );
        expect(sha256(pdfBytes.rawPayload)).toBe(sha256(pdf));
        const rev = (await api.req('GET', `/api/revisions/${expected.revisionApproved}`)).json();
        expect(rev.verificationType).toBe('authenticated_server');
        expect(rev.approvedBy.name).toBe('M. Gagnon');
        expect(rev.meta.approval.comment).toBe('Approuvé pour essai de restauration');
        const audit = (await api.req('GET', '/api/audit?limit=500')).json().events as { action: string }[];
        expect(audit.map((e) => e.action)).toEqual(
          expect.arrayContaining(['revision.approve', 'file.upload']),
        );
        const templates = (await api.req('GET', '/api/templates')).json().templates as {
          template: { logo: { sha256: string } };
        }[];
        expect(templates[0]!.template.logo.sha256).toBe(sha256(logo));
        // Isolation toujours active après restauration.
        const loginB = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-campplanner': '1' },
          payload: { email: 'admin@autre.test', password: PASSWORD, deviceMode: 'trusted' },
        });
        const apiB = client(app, `cp_session=${loginB.cookies.find((c) => c.name === 'cp_session')!.value}`);
        expect((await apiB.req('GET', `/api/files/${expected.photo}`)).statusCode).toBe(404);
        // Révision approuvée toujours immuable après restauration.
        const tamper = await pool.connect().then(async (c) => {
          try {
            await c.query('BEGIN');
            await c.query("SELECT set_config('app.org_id', $1, true)", [h.orgA.id]);
            await c.query("UPDATE revisions SET status = 'draft' WHERE id = $1", [expected.revisionApproved]);
            return 'modifiée';
          } catch {
            return 'refusée';
          } finally {
            await c.query('ROLLBACK').catch(() => undefined);
            c.release();
          }
        });
        expect(tamper).toBe('refusée');
      } finally {
        await app.close();
        await pool.end();
      }
    } finally {
      cluster.stop();
      rmSync(filesRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(!process.env.S3_TEST_ENDPOINT)(
    'restauration des fichiers dans un stockage S3 réel (autre compartiment) : SHA-256 identiques',
    async () => {
      const endpoint = process.env.S3_TEST_ENDPOINT!;
      const bucket = `campplanner-restore-${randomBytes(4).toString('hex')}`;
      await new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true }).send(
        new CreateBucketCommand({ Bucket: bucket }),
      );
      const storage = new S3Storage({
        driver: 's3',
        bucket,
        region: 'us-east-1',
        endpoint,
        forcePathStyle: true,
        prefix: 'restauration/',
      });
      const cluster = startCluster();
      try {
        const admin = new pg.Client({ connectionString: cluster.adminUrl });
        await admin.connect();
        await admin.query('CREATE DATABASE campplanner_s3');
        await admin.end();
        const report = await restore({
          fromDir: dir,
          databaseUrl: cluster.adminUrl.replace(/\/postgres$/, '/campplanner_s3'),
          storage,
          pgBin: PG_BIN,
        });
        expect(report.mismatches).toEqual([]);
        expect(report.files).toBe(report.manifest.files.length);
      } finally {
        cluster.stop();
      }
    },
    120_000,
  );
});
