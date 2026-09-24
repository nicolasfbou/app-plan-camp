/**
 * Base de test isolée par fichier : base neuve, migrations appliquées par le propriétaire, pool
 * applicatif connecté avec le rôle `campplanner_app` (NON propriétaire : la RLS s'applique
 * réellement, comme en production).
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createPool } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';

/**
 * `bypassRls` : le pool applicatif utilise un rôle qui CONTOURNE la RLS (tests « sans filet » :
 * l'isolation doit alors venir des seuls contrôles de l'API).
 */
export async function createTestDatabase({ bypassRls = false } = {}) {
  const adminUrl = inject('pgAdminUrl');
  const name = `cp_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // Rôle applicatif créé une fois (globalSetup) ; ici seulement s'il manque encore.
  await admin
    .query(
      `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campplanner_app') THEN
        CREATE ROLE campplanner_app LOGIN PASSWORD 'app';
      END IF; END $$;`,
    )
    .catch((error: { code?: string }) => {
      if (error.code !== '23505' && error.code !== '42710') throw error; // créé en parallèle
    });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const ownerUrl = url.toString();
  await migrate(ownerUrl);
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'campplanner_app';
  appUrl.password = 'app';
  if (bypassRls) {
    const role = `cp_bypass_${randomBytes(4).toString('hex')}`;
    const o = new pg.Client({ connectionString: ownerUrl });
    await o.connect();
    await o.query(`CREATE ROLE ${role} LOGIN PASSWORD 'bypass' BYPASSRLS IN ROLE campplanner_app`);
    await o.end();
    appUrl.username = role;
    appUrl.password = 'bypass';
  }
  const pool = createPool(appUrl.toString());
  const owner = createPool(ownerUrl);
  return {
    name,
    ownerUrl,
    appUrl: appUrl.toString(),
    pool,
    owner,
    async drop() {
      await pool.end();
      await owner.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
