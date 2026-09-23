/**
 * Migrations SQL versionnées (`server/migrations/NNN_nom.sql`), appliquées dans l'ordre, chacune
 * dans une transaction, une seule fois (table `schema_migrations`). Exécutées avec le rôle
 * propriétaire du schéma.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const DIR = new URL('../migrations/', import.meta.url).pathname;

export async function migrate(connectionString: string, log: (m: string) => void = () => undefined) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    // Un seul migrateur à la fois (plusieurs instances démarrant ensemble).
    await client.query('SELECT pg_advisory_lock(815001)');
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = readdirSync(DIR)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(DIR, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`migration appliquée : ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${file} échouée : ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    await client.query('SELECT pg_advisory_unlock(815001)');
  } finally {
    await client.end();
  }
}
