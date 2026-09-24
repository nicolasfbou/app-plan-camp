/**
 * Rôle applicatif `campplanner_app` sur une base gérée par un hébergeur (Railway…) où aucun
 * script d'initialisation ne peut être déposé : créé (ou son mot de passe resynchronisé) par le
 * propriétaire avant les migrations, puis ses droits (ré)appliqués après.
 *
 * Le mot de passe n'est jamais envoyé en clair au serveur PostgreSQL : seul son vérificateur
 * SCRAM-SHA-256 l'est (rien d'exploitable dans un journal de requêtes).
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type pg from 'pg';

export const APP_ROLE = 'campplanner_app';

/** Vérificateur SCRAM-SHA-256 au format de PostgreSQL (`pg_authid.rolpassword`). */
export function scramVerifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** Crée le rôle ou resynchronise son mot de passe ; jamais superutilisateur ni BYPASSRLS. */
export async function ensureAppRole(owner: pg.ClientBase, password: string): Promise<'created' | 'updated'> {
  const exists = (await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE])).rowCount;
  const verifier = scramVerifier(password);
  const sql = (
    await owner.query<{ q: string }>(
      exists
        ? "SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS q"
        : "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS q",
      [APP_ROLE, verifier],
    )
  ).rows[0]!.q;
  await owner.query(sql);
  const db = (await owner.query<{ d: string }>('SELECT current_database() AS d')).rows[0]!.d;
  await owner.query(
    (
      await owner.query<{ q: string }>(
        "SELECT format('GRANT CONNECT ON DATABASE %I TO %I', $1::text, $2::text) AS q",
        [db, APP_ROLE],
      )
    ).rows[0]!.q,
  );
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  return exists ? 'updated' : 'created';
}

/**
 * Droits du rôle applicatif, identiques à ceux des migrations (001, 003, 004) : réappliqués si le
 * rôle a été créé APRÈS elles (base déjà migrée). Idempotent.
 */
export async function grantAppRole(owner: pg.ClientBase): Promise<void> {
  await owner.query(`
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
    REVOKE UPDATE ON audit_events, plan_versions, revision_snapshots, change_log FROM ${APP_ROLE};
    GRANT DELETE ON sessions, idempotency_keys, camp_access TO ${APP_ROLE};
    REVOKE DELETE ON file_refs FROM ${APP_ROLE};
    REVOKE INSERT, UPDATE ON server_meta FROM ${APP_ROLE};
    REVOKE ALL ON schema_migrations FROM ${APP_ROLE};
  `);
}
