/**
 * Création d'une organisation et de son premier administrateur (installation, tests). Ensuite,
 * les autres comptes arrivent uniquement par invitation.
 */
import type pg from 'pg';
import { checkPasswordPolicy, hashPassword } from './auth/passwords.ts';

export async function createOrganization(
  pool: pg.Pool,
  input: { name: string; slug: string },
): Promise<{ id: string }> {
  const r = await pool.query<{ id: string }>(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [input.name, input.slug],
  );
  return r.rows[0]!;
}

/** Crée (ou réutilise, par courriel) un compte et l'ajoute à l'organisation avec ce rôle. */
export async function addUser(
  pool: pg.Pool,
  input: {
    orgId: string;
    email: string;
    displayName: string;
    password: string;
    role: 'admin' | 'manager' | 'editor' | 'reader';
  },
): Promise<{ id: string }> {
  const policy = checkPasswordPolicy(input.password);
  if (policy) throw new Error(policy);
  const email = input.email.toLowerCase();
  let user = (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0];
  if (!user) {
    user = (
      await pool.query<{ id: string }>(
        'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
        [email, input.displayName],
      )
    ).rows[0]!;
    await pool.query(
      "INSERT INTO user_identities (user_id, provider, subject, secret_hash) VALUES ($1, 'password', '', $2)",
      [user.id, await hashPassword(input.password)],
    );
  }
  await pool.query(
    'INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [input.orgId, user.id, input.role],
  );
  return user;
}
