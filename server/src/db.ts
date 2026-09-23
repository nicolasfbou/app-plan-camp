/**
 * Accès PostgreSQL. Toute requête métier passe par `tx`, qui ouvre une transaction et y fixe
 * l'organisation et l'utilisateur de la SESSION (`app.org_id`, `app.user_id`) : la sécurité au
 * niveau des lignes (RLS) n'expose alors que les lignes de cette organisation.
 */
import pg from 'pg';

export type Client = pg.PoolClient;

export interface Context {
  orgId: string | null;
  userId: string | null;
}

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // Les bigint (versions) sont renvoyés en nombre (valeurs toujours < 2^53 ici).
  pg.types.setTypeParser(20, (v) => Number(v));
  return pool;
}

export async function tx<T>(pool: pg.Pool, ctx: Context, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [
      ctx.orgId ?? '',
      ctx.userId ?? '',
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * L'isolation des organisations repose sur la RLS : un rôle superutilisateur ou `BYPASSRLS`
 * verrait toutes les organisations. Le serveur refuse de démarrer avec un tel rôle.
 */
export async function assertRowSecurityApplies(pool: pg.Pool): Promise<void> {
  const r = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const role = r.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls)
    throw new Error(
      `DATABASE_URL utilise le rôle « ${role?.rolname ?? '?'} », qui contourne la sécurité par ligne (RLS). ` +
        'Utilisez le rôle applicatif (campplanner_app) ; le propriétaire ne sert qu’aux migrations (MIGRATION_DATABASE_URL).',
    );
}
