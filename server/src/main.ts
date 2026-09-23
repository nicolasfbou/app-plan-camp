/**
 * Démarrage : `npm run server` (variables d'environnement, voir docs/PHASE9-SERVER.md).
 * Applique les migrations (rôle propriétaire), puis sert l'API (rôle applicatif) et l'application.
 */
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { migrate } from './migrate.ts';
import { createStorage } from './storage/storage.ts';

const config = loadConfig();
if (!config.databaseUrl) {
  console.error('DATABASE_URL manquant.');
  process.exit(1);
}
await migrate(config.migrationDatabaseUrl, (m) => console.log(m));
const app = await buildApp({
  config,
  pool: createPool(config.databaseUrl),
  storage: await createStorage(config.storage),
});
await app.listen({ host: config.host, port: config.port });
console.log(`CampPlanner : http://${config.host}:${config.port} (stockage : ${config.storage.driver})`);
