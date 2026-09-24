/**
 * Maintenance : supprime les fichiers jamais référencés (voir server/src/files/purge.ts).
 *   MIGRATION_DATABASE_URL=… STORAGE_DRIVER=… npm run server:purge-files -- [--dry-run] [--grace-hours 24]
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db.ts';
import { purgeUnusedFiles } from '../src/files/purge.ts';
import { createStorage } from '../src/storage/storage.ts';

const { values } = parseArgs({
  options: { 'dry-run': { type: 'boolean' }, 'grace-hours': { type: 'string' } },
});
const config = loadConfig();
const owner = createPool(config.migrationDatabaseUrl);
const result = await purgeUnusedFiles(owner, await createStorage(config.storage), {
  dryRun: values['dry-run'] ?? false,
  graceHours: Number(values['grace-hours'] ?? 24),
});
console.log(
  `${values['dry-run'] ? '[essai] ' : ''}${result.removed.length} fichier(s) non référencé(s) ${values['dry-run'] ? 'à supprimer' : 'supprimé(s)'} ; ${result.errors.length} erreur(s).`,
);
for (const e of result.errors) console.error(e);
await owner.end();
process.exit(result.errors.length ? 1 : 0);
