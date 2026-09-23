/**
 * Outils communs des écritures synchronisées :
 * - idempotence : une requête rejouée avec la même clé (`Idempotency-Key` = identifiant
 *   d'opération du client) renvoie la réponse mémorisée, sans rien refaire ;
 * - journal des changements (`change_log`) : curseur de synchronisation des clients.
 * Tout se fait dans la transaction de l'écriture.
 */
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Client } from './db.ts';
import { HttpError } from './errors.ts';
import type { Auth } from './permissions.ts';

export interface Idempotency {
  key: string;
  /**
   * Empreinte de la requête (version attendue + corps). Une clé rejouée avec un AUTRE contenu
   * est refusée : sinon le client croirait envoyé un contenu que le serveur n'a jamais reçu.
   */
  fingerprint: string;
}

export function idempotencyKey(request: FastifyRequest): Idempotency | null {
  const key = request.headers['idempotency-key'];
  if (key === undefined) return null;
  if (typeof key !== 'string' || !/^[A-Za-z0-9_:.-]{8,200}$/.test(key))
    throw new HttpError(400, 'bad-idempotency-key', 'Clé d’idempotence invalide.');
  const fingerprint = createHash('sha256')
    .update(String(request.headers['if-match'] ?? ''))
    .update('\n')
    .update(JSON.stringify(request.body ?? null))
    .digest('hex');
  return { key, fingerprint };
}

/** Réponse déjà donnée pour cette clé (même route, même contenu), ou `null`. */
export async function replayed(client: Client, auth: Auth, idem: Idempotency | null, route: string) {
  if (!idem) return null;
  const r = await client.query<{
    route: string;
    status: number;
    response: unknown;
    user_id: string;
    request_sha256: string | null;
  }>('SELECT route, status, response, user_id, request_sha256 FROM idempotency_keys WHERE key = $1', [
    idem.key,
  ]);
  const row = r.rows[0];
  if (!row) return null;
  if (row.route !== route || row.user_id !== auth.userId)
    throw new HttpError(
      422,
      'idempotency-key-reused',
      'Clé d’opération déjà utilisée pour une autre requête.',
    );
  if (row.request_sha256 !== null && row.request_sha256 !== idem.fingerprint)
    // Même opération, contenu changé depuis le premier envoi (réponse perdue puis nouvelles
    // modifications) : rien n'est enregistré ; la réponse d'origine est rendue pour que le client
    // sache ce que le serveur a réellement reçu, puis renvoie le contenu actuel sous une autre clé.
    throw new HttpError(
      422,
      'idempotency-key-reused',
      'Opération déjà reçue avec un autre contenu : renvoyez le contenu actuel sous une nouvelle clé.',
      { previous: { status: row.status, body: row.response } },
    );
  return { status: row.status, body: row.response };
}

export async function remember(
  client: Client,
  auth: Auth,
  idem: Idempotency | null,
  route: string,
  status: number,
  body: unknown,
) {
  if (!idem) return;
  await client.query(
    `INSERT INTO idempotency_keys (organization_id, key, user_id, route, status, response, request_sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [auth.orgId, idem.key, auth.userId, route, status, JSON.stringify(body), idem.fingerprint],
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
  // Les numéros de séquence sont attribués à l'insertion, mais les transactions se valident dans
  // un autre ordre : un client lisant entre deux validations sauterait définitivement une ligne.
  // Verrou par organisation jusqu'à la validation : l'ordre des numéros = l'ordre de validation.
  // (Appelé en fin de transaction : aucun autre verrou de ligne n'est pris ensuite.)
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`change_log:${orgId}`]);
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
