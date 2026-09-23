/** Modèles d'organisation (ex. « Modèle PAMM – Circulation ») : lecture pour tous, écriture Admin/Gestionnaire. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { templateSchema } from '@/domain/templates/template.ts';
import { type Deps, requireAuth } from '../app.ts';
import { audit } from '../audit.ts';
import { tx } from '../db.ts';
import { HttpError, notFound } from '../errors.ts';
import { requirePermission } from '../permissions.ts';
import { expectedVersion, idempotencyKey, logChange, remember, replayed } from '../sync.ts';
import { ID } from './camps.ts';

export function registerTemplateRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/templates', async (request) => {
    const auth = requireAuth(request);
    const r = await tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, (c) =>
      c.query(
        `SELECT id, name, body AS template, logo_sha256 AS "logoSha256", server_version AS "serverVersion",
                updated_at AS "updatedAt", deleted_at AS "deletedAt" FROM templates ORDER BY name`,
      ),
    );
    return { templates: r.rows };
  });

  app.put<{ Params: { id: string } }>('/api/templates/:id', async (request, reply) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'template.write');
    if (!ID.test(request.params.id)) throw notFound('Modèle');
    const body = z.object({ template: z.unknown() }).parse(request.body);
    const parsed = templateSchema.safeParse(body.template);
    if (!parsed.success) throw new HttpError(422, 'invalid-template', 'Modèle invalide.');
    const template = parsed.data;
    if (template.id !== request.params.id)
      throw new HttpError(422, 'invalid-template', 'Identifiant incohérent.');
    const expected = expectedVersion(request);
    const key = idempotencyKey(request);
    const route = `PUT template ${request.params.id}`;
    const result = await tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, async (c) => {
      const again = await replayed(c, auth, key, route);
      if (again) return again;
      const logo = template.logo?.sha256 ?? null;
      if (logo) {
        const f = await c.query('SELECT 1 FROM files WHERE sha256 = $1', [logo]);
        if (!f.rowCount)
          throw new HttpError(422, 'missing-files', 'Logo absent du serveur.', { missing: [logo] });
      }
      const current = (
        await c.query<{ server_version: number; deleted_at: Date | null }>(
          'SELECT server_version, deleted_at FROM templates WHERE id = $1 FOR UPDATE',
          [template.id],
        )
      ).rows[0];
      let version = 1;
      if (!current) {
        if (expected !== 0) throw new HttpError(409, 'deleted', 'Modèle supprimé sur le serveur.');
        await c.query(
          `INSERT INTO templates (organization_id, id, name, body, logo_sha256, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [auth.orgId, template.id, template.name, JSON.stringify(template), logo, auth.userId],
        );
      } else {
        if (current.deleted_at) throw new HttpError(409, 'deleted', 'Modèle supprimé sur le serveur.');
        if (expected !== current.server_version)
          throw new HttpError(409, 'version', 'Modèle modifié ailleurs.', {
            serverVersion: current.server_version,
          });
        version = current.server_version + 1;
        await c.query(
          `UPDATE templates SET name = $2, body = $3, logo_sha256 = $4, updated_by = $5, updated_at = now(),
                  server_version = $6 WHERE id = $1`,
          [template.id, template.name, JSON.stringify(template), logo, auth.userId, version],
        );
      }
      await c.query("DELETE FROM file_refs WHERE owner_kind = 'template' AND owner_id = $1", [template.id]);
      if (logo)
        await c.query(
          "INSERT INTO file_refs (organization_id, sha256, owner_kind, owner_id) VALUES ($1, $2, 'template', $3)",
          [auth.orgId, logo, template.id],
        );
      await logChange(c, auth.orgId, 'template', template.id, version);
      await audit(c, {
        orgId: auth.orgId,
        userId: auth.userId,
        action: current ? 'template.update' : 'template.create',
        targetKind: 'template',
        targetId: template.id,
        requestId: request.id,
        context: { name: template.name },
      });
      const response = { status: current ? 200 : 201, body: { serverVersion: version } };
      await remember(c, auth, key, route, response.status, response.body);
      return response;
    });
    return reply.status(result.status).send(result.body);
  });

  app.delete<{ Params: { id: string } }>('/api/templates/:id', async (request) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'template.write');
    return tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, async (c) => {
      const current = (
        await c.query<{ server_version: number; deleted_at: Date | null }>(
          'SELECT server_version, deleted_at FROM templates WHERE id = $1 FOR UPDATE',
          [request.params.id],
        )
      ).rows[0];
      if (!current) throw notFound('Modèle');
      if (current.deleted_at) return { serverVersion: current.server_version };
      const version = current.server_version + 1;
      await c.query('UPDATE templates SET deleted_at = now(), server_version = $2 WHERE id = $1', [
        request.params.id,
        version,
      ]);
      await logChange(c, auth.orgId, 'template', request.params.id, version, true);
      await audit(c, {
        orgId: auth.orgId,
        userId: auth.userId,
        action: 'template.delete',
        targetKind: 'template',
        targetId: request.params.id,
        requestId: request.id,
      });
      return { serverVersion: version };
    });
  });
}
