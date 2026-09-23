/**
 * Outils communs des écritures synchronisées :
 * - idempotence : une requête rejouée avec la même clé (`Idempotency-Key` = identifiant
 *   d'opération du client) renvoie la réponse mémorisée, sans rien refaire ;
 * - journal des changements (`change_log`) : curseur de synchronisation des clients.
 * Tout se fait dans la transaction de l'écriture.
 */
import type { FastifyRequest } from 'fastify';
import type { Client } from './db.ts';
import { HttpError } from './errors.ts';
import type { Auth } from './permissions.ts';

export function idempotencyKey(request: FastifyRequest): string | null {
  const key = request.headers['idempotency-key'];
  if (key === undefined) return null;
  if (typeof key !== 'string' || !/^[A-Za-z0-9_:.-]{8,200}$/.test(key))
    throw new HttpError(400, 'bad-idempotency-key', 'Clé d’idempotence invalide.');
  return key;
}

/** Réponse déjà donnée pour cette clé (même route), ou `null`. */
export async function replayed(client: Client, auth: Auth, key: string | null, route: string) {
  if (!key) return null;
  const r = await client.query<{ route: string; status: number; response: unknown; user_id: string }>(
    'SELECT route, status, response, user_id FROM idempotency_keys WHERE key = $1',
    [key],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.route !== route || row.user_id !== auth.userId)
    throw new HttpError(
      422,
      'idempotency-key-reused',
      'Clé d’opération déjà utilisée pour une autre requête.',
    );
  return { status: row.status, body: row.response };
}

export async function remember(
  client: Client,
  auth: Auth,
  key: string | null,
  route: string,
  status: number,
  body: unknown,
) {
  if (!key) return;
  await client.query(
    `INSERT INTO idempotency_keys (organization_id, key, user_id, route, status, response)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [auth.orgId, key, auth.userId, route, status, JSON.stringify(body)],
  );
}

export async function logChange(
  client: Client,
  orgId: string,
  kind: 'camp' | 'plan' | 'revision' | 'template',
  id: string,
  serverVersion: number,
  deleted = false,
) {
  await client.query(
    'INSERT INTO change_log (organization_id, kind, entity_id, server_version, deleted) VALUES ($1, $2, $3, $4, $5)',
    [orgId, kind, id, serverVersion, deleted],
  );
}

/** Version attendue (`If-Match`) : entier ≥ 0 ; 0 = création. */
export function expectedVersion(request: FastifyRequest): number {
  const raw = request.headers['if-match'];
  const value = Number(typeof raw === 'string' ? raw.replace(/"/g, '') : NaN);
  if (!Number.isInteger(value) || value < 0)
    throw new HttpError(428, 'precondition-required', 'Version attendue (If-Match) obligatoire.');
  return value;
}
