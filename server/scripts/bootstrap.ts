/**
 * Installation : crée une organisation et son premier administrateur.
 *   MIGRATION_DATABASE_URL=… BOOTSTRAP_PASSWORD=… npm run server:bootstrap -- \
 *     --org "PAMM" --slug pamm --email admin@pamm.example --name "Administrateur"
 * Le mot de passe est lu dans l'environnement (jamais en argument : il resterait dans l'historique).
 */
import { parseArgs } from 'node:util';
import { addUser, createOrganization } from '../src/bootstrap.ts';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    slug: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
  },
});
const password = process.env.BOOTSTRAP_PASSWORD ?? '';
if (!values.org || !values.slug || !values.email || !values.name || !password) {
  console.error(
    'Usage : BOOTSTRAP_PASSWORD=… bootstrap --org <nom> --slug <slug> --email <courriel> --name <nom>',
  );
  process.exit(1);
}
const config = loadConfig();
await migrate(config.migrationDatabaseUrl, console.log);
const pool = createPool(config.migrationDatabaseUrl);
const org = await createOrganization(pool, { name: values.org, slug: values.slug });
await addUser(pool, {
  orgId: org.id,
  email: values.email,
  displayName: values.name,
  password,
  role: 'admin',
});
console.log(`Organisation ${values.org} créée ; administrateur : ${values.email}`);
await pool.end();
