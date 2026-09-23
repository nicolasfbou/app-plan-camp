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
