/**
 * Déploiement pilote (Railway) : étape « avant déploiement » sur une base gérée SANS script
 * d'initialisation (rôle applicatif absent), premier administrateur sans aucun secret dans le
 * journal, sauvegardes dans un compartiment S3 distinct (rétention, restauration complète).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { APP_ROLE, grantAppRole } from '../src/ops/appRole.ts';
import {
  type BackupBucket,
  backupToBucket,
  listBucketBackups,
  restoreFromBucket,
} from '../src/ops/bucketBackup.ts';
import { FsStorage } from '../src/storage/fsStorage.ts';
import { createHarness, type Harness, seedPlan, sha256 } from './harness.ts';
import { startCluster } from './pgCluster.ts';

const PG_BIN = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
const ROOT = new URL('../..', import.meta.url).pathname;

function predeploy(env: Record<string, string>) {
  const r = spawnSync(
    join(ROOT, 'node_modules/.bin/tsx'),
    ['--tsconfig', 'server/tsconfig.json', 'server/scripts/predeploy.ts'],
    { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } },
  );
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const grantsOf = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (
      await c.query<{ t: string; p: string }>(
        `SELECT table_name AS t, privilege_type AS p FROM information_schema.role_table_grants
          WHERE grantee = $1 AND table_name <> 'schema_migrations' ORDER BY 1, 2`,
        [APP_ROLE],
      )
    ).rows.map((r) => `${r.t}:${r.p}`);
  } finally {
    await c.end();
  }
};

describe('avant déploiement (base gérée, sans script d’initialisation)', () => {
  let cluster: ReturnType<typeof startCluster>;
  const url = (db: string) => cluster.adminUrl.replace(/\/postgres$/, `/${db}`);
  const appPassword = randomBytes(24).toString('hex');
  const adminPassword = `Pilote-${randomBytes(9).toString('base64url')}`;
  let appUrl: string;
  beforeAll(async () => {
    cluster = startCluster();
    const admin = new pg.Client({ connectionString: cluster.adminUrl });
    await admin.connect();
    // Comme chez l'hébergeur : aucun rôle applicatif au départ.
    await admin.query(`DROP ROLE ${APP_ROLE}`);
    for (const db of ['railway', 'deja_migree']) await admin.query(`CREATE DATABASE ${db}`);
    await admin.end();
    const u = new URL(url('railway'));
    u.username = APP_ROLE;
    u.password = appPassword;
    appUrl = u.toString();
  });
  afterAll(() => cluster.stop());

  const env = () => ({
    MIGRATION_DATABASE_URL: url('railway'),
    DATABASE_URL: appUrl,
    APP_DB_PASSWORD: appPassword,
  });

  it('refuse une configuration dangereuse ou incohérente, sans rien afficher de secret', () => {
    const owner = predeploy({ ...env(), DATABASE_URL: url('railway') });
    expect(owner.code).toBe(1);
    expect(owner.out).toMatch(/rôle campplanner_app/);
    const mismatch = predeploy({ ...env(), APP_DB_PASSWORD: randomBytes(24).toString('hex') });
    expect(mismatch.code).toBe(1);
    expect(mismatch.out).toMatch(/ne correspond pas/);
    const short = predeploy({ ...env(), APP_DB_PASSWORD: 'court' });
    expect(short.code).toBe(1);
    for (const r of [owner, mismatch, short]) expect(r.out).not.toContain(appPassword);
  });

  it('première installation : rôle, migrations, droits, premier administrateur ; rien de secret dans le journal', async () => {
    // Base migrée AVANT la création du rôle (droits à réappliquer ensuite).
    await migrate(url('deja_migree'));
    const first = predeploy({
      ...env(),
      BOOTSTRAP_EMAIL: 'Admin@PAMM.test',
      BOOTSTRAP_NAME: 'Administrateur PAMM',
      BOOTSTRAP_PASSWORD: adminPassword,
    });
    expect(first.code, first.out).toBe(0);
    expect(first.out).toMatch(/Rôle applicatif campplanner_app : créé/);
    expect(first.out).toMatch(/administrateur : admin@pamm\.test/);
    for (const secret of [appPassword, adminPassword, url('railway')])
      expect(first.out).not.toContain(secret);

    // Le serveur démarre avec ce rôle (RLS active) et l'administrateur se connecte.
    const pool = createPool(appUrl);
    const files = mkdtempSync(join(tmpdir(), 'cp-pilote-'));
    const app = await buildApp({
      config: loadConfig({ DATABASE_URL: appUrl, STORAGE_FS_ROOT: files }),
      pool,
      storage: new FsStorage(files),
    });
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-campplanner': '1' },
        payload: { email: 'admin@pamm.test', password: adminPassword, deviceMode: 'trusted' },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().organization.name).toBe('PAMM');
      expect(login.json().role).toBe('admin');
    } finally {
      await app.close();
      await pool.end();
      rmSync(files, { recursive: true, force: true });
    }

    // Redéploiement : idempotent ; l'administrateur n'est jamais recréé ni modifié.
    const again = predeploy({
      ...env(),
      BOOTSTRAP_EMAIL: 'autre@pamm.test',
      BOOTSTRAP_PASSWORD: adminPassword,
    });
    expect(again.code, again.out).toBe(0);
    expect(again.out).toMatch(/Rôle applicatif campplanner_app : à jour/);
    expect(again.out).toMatch(/Installation déjà faite/);
    const owner = new pg.Client({ connectionString: url('railway') });
    await owner.connect();
    expect((await owner.query('SELECT email FROM users ORDER BY email')).rows).toEqual([
      { email: 'admin@pamm.test' },
    ]);
    // Jamais superutilisateur ni BYPASSRLS ; mot de passe stocké en SCRAM uniquement.
    const role = (
      await owner.query('SELECT rolsuper, rolbypassrls, rolpassword FROM pg_authid WHERE rolname = $1', [
        APP_ROLE,
      ])
    ).rows[0];
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
    expect(role.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
    await owner.end();

    // Base migrée avant la création du rôle : mêmes droits après grantAppRole.
    const late = new pg.Client({ connectionString: url('deja_migree') });
    await late.connect();
    await grantAppRole(late);
    await late.end();
    expect(await grantsOf(url('deja_migree'))).toEqual(await grantsOf(url('railway')));
    expect((await grantsOf(url('railway'))).length).toBeGreaterThan(20);
  }, 120_000);
});

describe.skipIf(!process.env.S3_TEST_ENDPOINT)('sauvegardes dans un compartiment S3 distinct', () => {
  let h: Harness;
  let bucket: BackupBucket;
  const endpoint = process.env.S3_TEST_ENDPOINT!;
  beforeAll(async () => {
    h = await createHarness();
    const name = `campplanner-sauvegardes-${randomBytes(4).toString('hex')}`;
    await new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true }).send(
      new CreateBucketCommand({ Bucket: name }),
    );
    bucket = {
      bucket: name,
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      prefix: 'campplanner/',
    };
  });
  afterAll(() => h.close());

  it('rétention, sauvegarde incomplète jamais proposée, restauration complète et vérifiée', async () => {
    const manager = await h.login('gestion@pamm.test');
    const { photo } = await seedPlan(manager);
    const run = (at: string) =>
      backupToBucket({
        databaseUrl: h.db.ownerUrl,
        storage: h.storage,
        bucket,
        keep: 2,
        pgBin: PG_BIN,
        now: new Date(at),
      });
    // Envoi interrompu simulé : objets sans manifeste.
    await new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true }).send(
      new PutObjectCommand({
        Bucket: bucket.bucket,
        Key: `${bucket.prefix}2026-01-01T00-00-00-000Z/database.dump`,
        Body: 'partiel',
      }),
    );
    const first = await run('2026-09-20T07:00:00Z');
    expect(first.removed).toEqual(['2026-01-01T00-00-00-000Z']); // incomplète, plus ancienne
    expect((await run('2026-09-21T07:00:00Z')).removed).toEqual([]);
    const last = await run('2026-09-22T07:00:00Z');
    expect(last.removed).toEqual(['2026-09-20T07-00-00-000Z']); // rétention : 2 gardées
    const listed = await listBucketBackups(bucket);
    expect(listed.map((e) => [e.stamp, e.complete])).toEqual([
      ['2026-09-21T07-00-00-000Z', true],
      ['2026-09-22T07-00-00-000Z', true],
    ]);
    await expect(
      restoreFromBucket({ bucket, stamp: '2026-01-01T00-00-00-000Z', databaseUrl: 'x', storage: h.storage }),
    ).rejects.toThrow(/introuvable/);

    // Restauration de la plus récente sur un AUTRE serveur PostgreSQL et un autre stockage.
    const cluster = startCluster();
    const files = mkdtempSync(join(tmpdir(), 'cp-pilote-restauree-'));
    try {
      const admin = new pg.Client({ connectionString: cluster.adminUrl });
      await admin.connect();
      await admin.query('CREATE DATABASE restauree');
      await admin.end();
      const storage = new FsStorage(files);
      const report = await restoreFromBucket({
        bucket,
        databaseUrl: cluster.adminUrl.replace(/\/postgres$/, '/restauree'),
        storage,
        pgBin: PG_BIN,
      });
      expect(report.stamp).toBe('2026-09-22T07-00-00-000Z');
      expect(report.mismatches).toEqual([]);
      const key = report.manifest.files.find((f) => f.sha256 === sha256(photo))!.storageKey;
      const chunks: Buffer[] = [];
      for await (const c of (await storage.get(key))!) chunks.push(c as Buffer);
      expect(sha256(Buffer.concat(chunks))).toBe(sha256(photo));
    } finally {
      cluster.stop();
      rmSync(files, { recursive: true, force: true });
    }
  }, 120_000);
});
