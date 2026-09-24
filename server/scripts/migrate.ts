/**
 * Migrations seules (étape séparée du démarrage, avant une mise à jour) :
 *   MIGRATION_DATABASE_URL=… npm run server:migrate
 * Faire une sauvegarde complète AVANT (retour arrière = restauration ; migrations non réversibles).
 */
import { loadConfig } from '../src/config.ts';
import { migrate } from '../src/migrate.ts';

const config = loadConfig();
if (!config.migrationDatabaseUrl) {
  console.error('MIGRATION_DATABASE_URL (ou DATABASE_URL) manquant.');
  process.exit(1);
}
await migrate(config.migrationDatabaseUrl, (m) => console.log(m));
console.log('Schéma à jour.');
