/**
 * Sauvegarde complète (base + fichiers), vérification, restauration. Voir docs/OPERATIONS.md.
 *
 *   # Sauvegarde (rôle propriétaire avec BYPASSRLS ; stockage configuré comme le serveur)
 *   MIGRATION_DATABASE_URL=… STORAGE_DRIVER=… npm run server:backup -- backup --out /sauvegardes/2026-09-24
 *   # Vérification d'une sauvegarde (aucune écriture)
 *   npm run server:backup -- verify --from /sauvegardes/2026-09-24
 *   # Restauration dans une base VIDE et un stockage cible (environnement de test isolé)
 *   MIGRATION_DATABASE_URL=<base vide> STORAGE_DRIVER=… npm run server:backup -- restore --from /sauvegardes/2026-09-24
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { backup, restore, verifyBackup } from '../src/ops/backup.ts';
import { createStorage } from '../src/storage/storage.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' }, from: { type: 'string' } },
});
const command = positionals[0];
const config = () => loadConfig();

if (command === 'backup' && values.out) {
  const c = config();
  const m = await backup({
    databaseUrl: c.migrationDatabaseUrl,
    storage: await createStorage(c.storage),
    outDir: values.out,
  });
  console.log(
    `Sauvegarde complète : ${values.out}\n  base : ${m.database.bytes} octets (SHA-256 ${m.database.sha256})\n  fichiers : ${m.files.length}\n  comptes : ${JSON.stringify(m.counts)}`,
  );
} else if (command === 'verify' && values.from) {
  const m = await verifyBackup(values.from);
  console.log(`Sauvegarde intègre (${m.createdAt}) : base et ${m.files.length} fichier(s) vérifiés.`);
} else if (command === 'restore' && values.from) {
  const c = config();
  const r = await restore({
    fromDir: values.from,
    databaseUrl: c.migrationDatabaseUrl,
    storage: await createStorage(c.storage),
  });
  console.log(`Restauration : ${r.files} fichier(s) ; comptes ${JSON.stringify(r.counts)}`);
  if (r.mismatches.length) {
    console.error(`ÉCARTS (${r.mismatches.length}) :\n  ${r.mismatches.join('\n  ')}`);
    process.exit(1);
  }
  console.log('Vérification : comptes, empreintes de contenu et fichiers identiques à la sauvegarde.');
} else {
  console.error('Usage : backup --out <dossier> | verify --from <dossier> | restore --from <dossier>');
  process.exit(2);
}
