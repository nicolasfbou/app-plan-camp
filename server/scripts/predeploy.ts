/**
 * Étape « avant déploiement » (Railway : preDeployCommand ; ailleurs : avant de démarrer une
 * nouvelle version). S'arrête au premier problème : la nouvelle version n'est alors pas mise en
 * service, l'ancienne continue de tourner.
 *
 *   1. rôle applicatif `campplanner_app` créé ou mot de passe resynchronisé (APP_DB_PASSWORD) ;
 *   2. migrations (rôle propriétaire : MIGRATION_DATABASE_URL) ;
 *   3. droits du rôle applicatif réappliqués ;
 *   4. vérification : DATABASE_URL se connecte avec ce rôle, et la RLS s'applique à lui ;
 *   5. PREMIÈRE installation seulement, si BOOTSTRAP_PASSWORD est défini : organisation et premier
 *      administrateur (BOOTSTRAP_EMAIL, BOOTSTRAP_NAME, BOOTSTRAP_ORG, BOOTSTRAP_SLUG). Ignoré dès
 *      qu'une organisation existe. Ni le mot de passe ni aucune URL de connexion ne sont écrits
 *      dans le journal.
 */
import pg from 'pg';
import { addUser, createOrganization } from '../src/bootstrap.ts';
import { resolveFileSecrets } from '../src/config.ts';
import { assertRowSecurityApplies, createPool } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { APP_ROLE, ensureAppRole, grantAppRole } from '../src/ops/appRole.ts';

const env = resolveFileSecrets(process.env);
const fail = (message: string): never => {
  console.error(`Avant déploiement : ${message}`);
  process.exit(1);
};

const ownerUrl = env.MIGRATION_DATABASE_URL ?? fail('MIGRATION_DATABASE_URL manquant (rôle propriétaire).');
const appUrl = env.DATABASE_URL ?? fail('DATABASE_URL manquant (rôle applicatif).');
const appPassword = env.APP_DB_PASSWORD ?? fail('APP_DB_PASSWORD manquant.');
if (appPassword.length < 24) fail('APP_DB_PASSWORD trop court (24 caractères au moins).');
let parsed: URL;
try {
  parsed = new URL(appUrl);
} catch {
  fail('DATABASE_URL illisible.');
}
if (decodeURIComponent(parsed!.username) !== APP_ROLE)
  fail(`DATABASE_URL doit utiliser le rôle ${APP_ROLE} (jamais le propriétaire).`);
if (decodeURIComponent(parsed!.password) !== appPassword)
  fail('Le mot de passe de DATABASE_URL ne correspond pas à APP_DB_PASSWORD.');

// 1. Rôle applicatif.
const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
try {
  const state = await ensureAppRole(owner, appPassword);
  console.log(`Rôle applicatif ${APP_ROLE} : ${state === 'created' ? 'créé' : 'à jour'}.`);
} finally {
  await owner.end();
}

// 2. Migrations, 3. droits.
await migrate(ownerUrl, (m) => console.log(m));
const grants = new pg.Client({ connectionString: ownerUrl });
await grants.connect();
try {
  await grantAppRole(grants);
} finally {
  await grants.end();
}
console.log('Schéma à jour ; droits du rôle applicatif appliqués.');

// 4. Vérification avec la connexion qu'utilisera le serveur.
const app = createPool(appUrl);
try {
  await assertRowSecurityApplies(app);
  await app.query('SELECT count(*) FROM organizations');
} finally {
  await app.end();
}
console.log('Connexion du serveur vérifiée (rôle applicatif, sécurité par ligne active).');

// 5. Premier administrateur (première installation uniquement).
if (env.BOOTSTRAP_PASSWORD) {
  const email = env.BOOTSTRAP_EMAIL ?? fail('BOOTSTRAP_EMAIL manquant.');
  const pool = createPool(ownerUrl);
  try {
    const existing = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM organizations');
    if (existing.rows[0]!.n > 0) {
      console.log(
        'Installation déjà faite : BOOTSTRAP_PASSWORD ignoré. Supprimez maintenant cette variable.',
      );
    } else {
      const org = await createOrganization(pool, {
        name: env.BOOTSTRAP_ORG ?? 'PAMM',
        slug: env.BOOTSTRAP_SLUG ?? 'pamm',
      });
      await addUser(pool, {
        orgId: org.id,
        email,
        displayName: env.BOOTSTRAP_NAME ?? 'Administrateur',
        password: env.BOOTSTRAP_PASSWORD,
        role: 'admin',
      });
      console.log(
        `Organisation ${env.BOOTSTRAP_ORG ?? 'PAMM'} créée ; administrateur : ${email.toLowerCase()}. Supprimez maintenant BOOTSTRAP_PASSWORD.`,
      );
    }
  } catch (error) {
    // Message de la politique de mot de passe au plus ; jamais la valeur.
    fail(`premier administrateur non créé : ${error instanceof Error ? error.message : 'erreur'}`);
  } finally {
    await pool.end();
  }
}
