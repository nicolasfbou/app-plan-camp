/**
 * Plans : concurrence optimiste (`If-Match` = version serveur sur laquelle repose l'envoi),
 * historique COMPLET (`plan_versions`, ajout seul), suppression logique, idempotence.
 * Un envoi fondé sur une version périmée n'écrase JAMAIS : 409 avec la version serveur (auteur,
 * date) pour que le client affiche le conflit.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Deps, requireAuth } from '../app.ts';
import { audit } from '../audit.ts';
import { type Client, tx } from '../db.ts';
import { referencedShas, validatePlanDocument } from '../documents.ts';
import { HttpError, notFound } from '../errors.ts';
import { reachableShas } from '../files/reachable.ts';
import { type Auth, allowedCampIds, requireCampAccess, requirePermission } from '../permissions.ts';
import { expectedVersion, idempotencyKey, logChange, remember, replayed } from '../sync.ts';
import { ID } from './camps.ts';

const planBody = z.object({
  campId: z.string().regex(ID),
  document: z.unknown(),
  /** Origine d'une création (audit) : saisie, import d'un .campplan, publication d'un projet local. */
  origin: z.enum(['create', 'import', 'publish']).default('create'),
});

interface PlanRow {
  id: string;
  camp_id: string;
  name: string;
  server_version: number;
  deleted_at: Date | null;
  updated_at: Date;
  updated_by: string;
}

async function planRow(c: Client, auth: Auth, id: string, lock = false): Promise<PlanRow | undefined> {
  if (!ID.test(id)) return undefined;
  const row = (
    await c.query<PlanRow>(
      `SELECT id, camp_id, name, server_version, deleted_at, updated_at, updated_by FROM plans
        WHERE organization_id = $2 AND id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id, auth.orgId],
    )
  ).rows[0];
  if (row) await requireCampAccess(c, auth, row.camp_id);
  return row;
}

/** Détail d'une version serveur (conflit) : auteur, date, numéro. */
async function versionInfo(c: Client, row: PlanRow) {
  const author = await c.query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [
    row.updated_by,
  ]);
  return {
    serverVersion: row.server_version,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: author.rows[0]?.display_name ?? '',
    deleted: row.deleted_at !== null,
  };
}

export function registerPlanRoutes(app: FastifyInstance, deps: Deps) {
  const ctx = (auth: Auth) => ({ orgId: auth.orgId, userId: auth.userId });

  app.get<{ Querystring: { campId?: string } }>('/api/plans', async (request) => {
    const auth = requireAuth(request);
    return tx(deps.pool, ctx(auth), async (c) => {
      const allowed = await allowedCampIds(c, auth);
      const r = await c.query(
        `SELECT p.id, p.camp_id AS "campId", p.name, p.kind, p.status, p.server_version AS "serverVersion",
                p.updated_at AS "updatedAt", u.display_name AS "updatedBy", p.deleted_at AS "deletedAt"
           FROM plans p JOIN users u ON u.id = p.updated_by
          WHERE p.organization_id = $2 AND ($1::text IS NULL OR p.camp_id = $1) ORDER BY p.name`,
        [request.query.campId ?? null, auth.orgId],
      );
      return { plans: r.rows.filter((row) => !allowed || allowed.has(row.campId)) };
    });
  });

  app.get<{ Params: { id: string } }>('/api/plans/:id', async (request) => {
    const auth = requireAuth(request);
    return tx(deps.pool, ctx(auth), async (c) => {
      const row = await planRow(c, auth, request.params.id);
      if (!row) throw notFound('Plan');
      // Dernier document enregistré (une suppression / restauration change la version serveur
      // sans créer de nouveau document).
      const doc = await c.query<{ document: unknown }>(
        'SELECT document FROM plan_versions WHERE organization_id = $2 AND plan_id = $1 ORDER BY version DESC LIMIT 1',
        [row.id, auth.orgId],
      );
      return { campId: row.camp_id, ...(await versionInfo(c, row)), document: doc.rows[0]?.document ?? null };
    });
  });

  app.get<{ Params: { id: string } }>('/api/plans/:id/versions', async (request) => {
    const auth = requireAuth(request);
    return tx(deps.pool, ctx(auth), async (c) => {
      if (!(await planRow(c, auth, request.params.id))) throw notFound('Plan');
      const r = await c.query(
        `SELECT v.version, v.base_version AS "baseVersion", v.created_at AS "createdAt",
                u.display_name AS "author", v.document_sha256 AS "sha256"
           FROM plan_versions v JOIN users u ON u.id = v.author_id
          WHERE v.organization_id = $2 AND v.plan_id = $1 ORDER BY v.version DESC`,
        [request.params.id, auth.orgId],
      );
      return { versions: r.rows };
    });
  });

  app.get<{ Params: { id: string; version: string } }>(
    '/api/plans/:id/versions/:version',
    async (request) => {
      const auth = requireAuth(request);
      return tx(deps.pool, ctx(auth), async (c) => {
        if (!(await planRow(c, auth, request.params.id))) throw notFound('Plan');
        const r = await c.query(
          'SELECT document FROM plan_versions WHERE organization_id = $3 AND plan_id = $1 AND version = $2',
          [request.params.id, Number(request.params.version) || 0, auth.orgId],
        );
        if (!r.rows[0]) throw notFound('Version');
        return { document: r.rows[0].document };
      });
    },
  );

  app.put<{ Params: { id: string } }>('/api/plans/:id', async (request, reply) => {
    const auth = requireAuth(request);
    if (!ID.test(request.params.id)) throw notFound('Plan');
    const body = planBody.parse(request.body);
    const expected = expectedVersion(request);
    const key = idempotencyKey(request);
    const route = `PUT plan ${request.params.id}`;
    const { doc, json, sha256 } = validatePlanDocument(body.document);
    if (doc.plan.id !== request.params.id || doc.plan.siteId !== body.campId)
      throw new HttpError(422, 'invalid-document', 'Identifiants du document incohérents avec la requête.');
    const result = await tx(deps.pool, ctx(auth), async (c) => {
      const again = await replayed(c, auth, key, route);
      if (again) return again;
      const current = await planRow(c, auth, request.params.id, true);
      let version: number;
      if (!current) {
        if (expected !== 0)
          throw new HttpError(409, 'deleted', 'Ce plan n’existe plus sur le serveur.', { deleted: true });
        requirePermission(auth, 'plan.create');
        // Référence vérifiée : le camp appartient à l'organisation de la session et existe encore.
        // FOR SHARE : une suppression simultanée du camp (FOR UPDATE) attend la fin de cette
        // création, puis voit le plan et refuse (jamais de plan dans un camp supprimé).
        const camp = await c.query(
          'SELECT 1 FROM camps WHERE organization_id = $2 AND id = $1 AND deleted_at IS NULL FOR SHARE',
          [body.campId, auth.orgId],
        );
        if (!camp.rowCount) throw new HttpError(409, 'camp-missing', 'Camp absent du serveur.');
        await requireCampAccess(c, auth, body.campId);
        version = 1;
      } else {
        requirePermission(auth, 'plan.write');
        if (current.deleted_at)
          throw new HttpError(
            409,
            'deleted',
            'Ce plan a été supprimé sur le serveur.',
            await versionInfo(c, current),
          );
        if (current.camp_id !== body.campId)
          throw new HttpError(422, 'camp-mismatch', 'Changer un plan de camp n’est pas pris en charge.');
        if (expected !== current.server_version)
          throw new HttpError(
            409,
            'version',
            'Le plan a été modifié ailleurs depuis votre dernière synchronisation.',
            await versionInfo(c, current),
          );
        version = current.server_version + 1;
      }
      // Fichiers référencés : tous doivent être présents dans l'organisation.
      const shas = referencedShas(doc);
      // Présents ET accessibles : un fichier d'un camp hors de portée n'est pas citable.
      const present = await reachableShas(c, auth, shas);
      const missing = shas.filter((s) => !present.has(s));
      if (missing.length)
        throw new HttpError(422, 'missing-files', 'Fichiers absents du serveur : envoyez-les d’abord.', {
          missing,
        });
      if (!current)
        await c.query(
          `INSERT INTO plans (organization_id, id, camp_id, name, kind, status, created_by, updated_by, server_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 1)`,
          [
            auth.orgId,
            doc.plan.id,
            body.campId,
            doc.plan.name,
            doc.plan.kind,
            doc.plan.titleBlock.status,
            auth.userId,
          ],
        );
      else
        await c.query(
          `UPDATE plans SET name = $2, kind = $3, status = $4, updated_by = $5, updated_at = now(), server_version = $6
            WHERE organization_id = $7 AND id = $1`,
          [
            doc.plan.id,
            doc.plan.name,
            doc.plan.kind,
            doc.plan.titleBlock.status,
            auth.userId,
            version,
            auth.orgId,
          ],
        );
      await c.query(
        `INSERT INTO plan_versions (organization_id, plan_id, version, base_version, document, document_sha256, schema_version, author_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [auth.orgId, doc.plan.id, version, expected, json, sha256, doc.schemaVersion, auth.userId],
      );
      // Références de fichiers CUMULÉES sur tout l'historique du plan (jamais retirées) : un
      // fichier d'une ancienne version reste protégé tant que cette version existe.
      for (const s of shas)
        await c.query(
          `INSERT INTO file_refs (organization_id, sha256, owner_kind, owner_id) VALUES ($1, $2, 'plan', $3)
           ON CONFLICT DO NOTHING`,
          [auth.orgId, s, doc.plan.id],
        );
      await logChange(c, auth.orgId, 'plan', doc.plan.id, version);
      await audit(c, {
        orgId: auth.orgId,
        userId: auth.userId,
        action: current ? 'plan.update' : (`plan.${body.origin}` as const),
        targetKind: 'plan',
        targetId: doc.plan.id,
        requestId: request.id,
        context: { version, baseVersion: expected, objects: Object.keys(doc.objects).length },
      });
      const response = { status: current ? 200 : 201, body: { serverVersion: version } };
      await remember(c, auth, key, route, response.status, response.body);
      return response;
    });
    return reply.status(result.status).send(result.body);
  });

  app.delete<{ Params: { id: string } }>('/api/plans/:id', async (request, reply) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'plan.delete');
    const expected = expectedVersion(request);
    const key = idempotencyKey(request);
    const route = `DELETE plan ${request.params.id}`;
    const result = await tx(deps.pool, ctx(auth), async (c) => {
      const again = await replayed(c, auth, key, route);
      if (again) return again;
      const current = await planRow(c, auth, request.params.id, true);
      if (!current) throw notFound('Plan');
      if (current.deleted_at) return { status: 200, body: { serverVersion: current.server_version } };
      if (expected !== current.server_version)
        throw new HttpError(409, 'version', 'Le plan a été modifié ailleurs.', await versionInfo(c, current));
      const version = current.server_version + 1;
      // Suppression LOGIQUE : historique, révisions (dont approuvées) et fichiers conservés.
      await c.query(
        'UPDATE plans SET deleted_at = now(), server_version = $2, updated_by = $3, updated_at = now() WHERE organization_id = $4 AND id = $1',
        [current.id, version, auth.userId, auth.orgId],
      );
      await logChange(c, auth.orgId, 'plan', current.id, version, true);
      await audit(c, {
        orgId: auth.orgId,
        userId: auth.userId,
        action: 'plan.delete',
        targetKind: 'plan',
        targetId: current.id,
        requestId: request.id,
        context: { version },
      });
      const response = { status: 200, body: { serverVersion: version } };
      await remember(c, auth, key, route, response.status, response.body);
      return response;
    });
    return reply.status(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>('/api/plans/:id/restore', async (request) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'plan.delete');
    return tx(deps.pool, ctx(auth), async (c) => {
      const current = await planRow(c, auth, request.params.id, true);
      if (!current) throw notFound('Plan');
      if (!current.deleted_at) return { serverVersion: current.server_version };
      const version = current.server_version + 1;
      await c.query(
        'UPDATE plans SET deleted_at = NULL, server_version = $2, updated_by = $3, updated_at = now() WHERE organization_id = $4 AND id = $1',
        [current.id, version, auth.userId, auth.orgId],
      );
      // Le document restauré est la dernière version connue (nouvelle entrée d'historique).
      await c.query(
        `INSERT INTO plan_versions (organization_id, plan_id, version, base_version, document, document_sha256, schema_version, author_id)
         SELECT organization_id, plan_id, $2, $4, document, document_sha256, schema_version, $3
           FROM plan_versions WHERE organization_id = $5 AND plan_id = $1 ORDER BY version DESC LIMIT 1`,
        [current.id, version, auth.userId, current.server_version, auth.orgId],
      );
      await logChange(c, auth.orgId, 'plan', current.id, version);
      await audit(c, {
        orgId: auth.orgId,
        userId: auth.userId,
        action: 'plan.restore',
        targetKind: 'plan',
        targetId: current.id,
        requestId: request.id,
      });
      return { serverVersion: version };
    });
  });
}
