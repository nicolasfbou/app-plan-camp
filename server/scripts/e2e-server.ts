/**
 * Serveur jetable pour les tests de bout en bout et la démonstration Camp 105 :
 * PostgreSQL temporaire, organisations PAMM et « Autre entreprise » avec un compte par rôle,
 * stockage disque temporaire, application construite (`dist/`) servie sur la même origine.
 *   PORT=8787 npx tsx --tsconfig server/tsconfig.json server/scripts/e2e-server.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { addUser, createOrganization } from '../src/bootstrap.ts';
import { loadConfig } from '../src/config.ts';
import { assertRowSecurityApplies, createPool } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { FsStorage } from '../src/storage/fsStorage.ts';
import { startCluster } from '../test/pgCluster.ts';

const PASSWORD = process.env.E2E_PASSWORD ?? 'mot-de-passe-solide-2026';
const cluster = startCluster();
const admin = new pg.Client({ connectionString: cluster.adminUrl });
await admin.connect();
await admin.query('CREATE DATABASE campplanner_e2e');
await admin.end();
const ownerUrl = cluster.adminUrl.replace(/\/postgres$/, '/campplanner_e2e');
await migrate(ownerUrl);
const owner = createPool(ownerUrl);
const pamm = await createOrganization(owner, { name: 'PAMM', slug: 'pamm' });
const autre = await createOrganization(owner, { name: 'Autre entreprise', slug: 'autre' });
const users: [string, string, string, 'admin' | 'manager' | 'editor' | 'reader'][] = [
  [pamm.id, 'admin@pamm.test', 'Admin PAMM', 'admin'],
  [pamm.id, 'gestion@pamm.test', 'M. Gagnon', 'manager'],
  [pamm.id, 'edition@pamm.test', 'N. Tremblay', 'editor'],
  [pamm.id, 'lecture@pamm.test', 'L. Roy', 'reader'],
  // Comptes réservés aux tests de révocation (jamais utilisés par les autres tests en parallèle).
  [pamm.id, 'suspendu@pamm.test', 'S. Suspendu', 'reader'],
  [pamm.id, 'cible@pamm.test', 'C. Cible', 'reader'],
  [autre.id, 'admin@autre.test', 'Admin Autre', 'admin'],
];
for (const [orgId, email, displayName, role] of users)
  await addUser(owner, { orgId, email, displayName, password: PASSWORD, role });
await owner.end();

const files = mkdtempSync(join(tmpdir(), 'campplanner-e2e-files-'));
const appUrl = new URL(ownerUrl);
appUrl.username = 'campplanner_app';
const port = Number(process.env.PORT ?? 8787);
const config = loadConfig({
  DATABASE_URL: appUrl.toString(),
  STORAGE_FS_ROOT: files,
  STATIC_DIR: process.env.STATIC_DIR ?? 'dist',
  PORT: String(port),
  PUBLIC_ORIGIN: `http://localhost:${port}`,
});
const pool = createPool(config.databaseUrl);
await assertRowSecurityApplies(pool);
const app = await buildApp({ config, pool, storage: new FsStorage(files) });
await app.listen({ host: '127.0.0.1', port });
console.log(`Serveur de test CampPlanner : http://localhost:${port} (base ${ownerUrl})`);
const stop = async () => {
  await app.close().catch(() => undefined);
  cluster.stop();
  rmSync(files, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
