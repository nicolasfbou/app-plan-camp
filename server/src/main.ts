/**
 * Démarrage : `npm run server` (variables d'environnement, voir docs/PHASE9-SERVER.md).
 * Applique les migrations (rôle propriétaire), puis sert l'API (rôle applicatif) et l'application.
 */
import { buildApp } from './app.ts';
import { applyFileSecretsToEnv, loadConfig } from './config.ts';
import { assertRowSecurityApplies, createPool } from './db.ts';
import { migrate } from './migrate.ts';
import { createStorage } from './storage/storage.ts';

// Secrets montés en fichiers (`*_FILE`) : les identifiants S3 sont lus par le SDK dans
// l'environnement du processus.
applyFileSecretsToEnv();
const config = loadConfig();
if (!config.databaseUrl) {
  console.error('DATABASE_URL manquant.');
  process.exit(1);
}
if (config.migrateOnStart) await migrate(config.migrationDatabaseUrl, (m) => console.log(m));
const pool = createPool(config.databaseUrl);
await assertRowSecurityApplies(pool);
const app = await buildApp({
  config,
  pool,
  storage: await createStorage(config.storage),
});
// Arrêt propre (redémarrage, mise à jour) : requêtes en cours terminées, connexions fermées.
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void app
      .close()
      .then(() => pool.end())
      .finally(() => process.exit(0));
  });
await app.listen({ host: config.host, port: config.port });
console.log(`CampPlanner : http://${config.host}:${config.port} (stockage : ${config.storage.driver})`);
