/**
 * Sauvegardes dans un compartiment S3 distinct (voir src/ops/bucketBackup.ts et docs/RAILWAY.md).
 *
 *   backup-bucket.ts backup                 sauvegarde complète + rétention (BACKUP_KEEP, 14 par défaut)
 *   backup-bucket.ts list                   sauvegardes présentes
 *   backup-bucket.ts restore [--stamp X]    restauration dans une base VIDE (la plus récente par défaut)
 *
 * Variables : MIGRATION_DATABASE_URL (propriétaire, sans filtre RLS), stockage des fichiers comme le
 * serveur (STORAGE_DRIVER, S3_*, AWS_*), compartiment des sauvegardes (BACKUP_S3_*).
 * Aucune URL de connexion ni aucun secret n'est écrit dans le journal.
 */
import { parseArgs } from 'node:util';
import pg from 'pg';
import { applyFileSecretsToEnv, loadConfig, resolveFileSecrets } from '../src/config.ts';
import { ensureAppRole } from '../src/ops/appRole.ts';
import {
  backupBucketFromEnv,
  backupToBucket,
  listBucketBackups,
  restoreFromBucket,
} from '../src/ops/bucketBackup.ts';
import { createStorage } from '../src/storage/storage.ts';

applyFileSecretsToEnv();
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { stamp: { type: 'string' } },
});
const env = resolveFileSecrets(process.env);
const bucket = backupBucketFromEnv(env);
const command = positionals[0];

if (command === 'list') {
  for (const e of await listBucketBackups(bucket))
    console.log(
      `${e.stamp}  ${e.complete ? 'complète  ' : 'INCOMPLÈTE'}  ${e.objects} objets  ${e.bytes} octets`,
    );
} else if (command === 'backup') {
  const config = loadConfig();
  const r = await backupToBucket({
    databaseUrl: config.migrationDatabaseUrl,
    storage: await createStorage(config.storage),
    bucket,
    keep: Number(env.BACKUP_KEEP ?? 14),
  });
  console.log(
    `Sauvegarde ${r.stamp} déposée : base ${r.manifest.database.bytes} octets, ${r.manifest.files.length} fichier(s) ; comptes ${JSON.stringify(r.manifest.counts)}`,
  );
  if (r.removed.length)
    console.log(`Rétention : ${r.removed.length} ancienne(s) sauvegarde(s) supprimée(s).`);
} else if (command === 'restore') {
  const config = loadConfig();
  // Base neuve chez l'hébergeur : le rôle applicatif n'existe pas encore (exigé par la restauration).
  if (env.APP_DB_PASSWORD) {
    const owner = new pg.Client({ connectionString: config.migrationDatabaseUrl });
    await owner.connect();
    try {
      await ensureAppRole(owner, env.APP_DB_PASSWORD);
    } finally {
      await owner.end();
    }
  }
  const r = await restoreFromBucket({
    bucket,
    stamp: values.stamp,
    databaseUrl: config.migrationDatabaseUrl,
    storage: await createStorage(config.storage),
  });
  console.log(`Restauration de ${r.stamp} : ${r.files} fichier(s) ; comptes ${JSON.stringify(r.counts)}`);
  if (r.mismatches.length) {
    console.error(`ÉCARTS :\n${r.mismatches.join('\n')}`);
    process.exit(2);
  }
  console.log('Vérification : comptes, empreintes de contenu et fichiers identiques à la sauvegarde.');
} else {
  console.error('Usage : backup-bucket.ts backup | list | restore [--stamp AAAA-MM-JJT…]');
  process.exit(1);
}
