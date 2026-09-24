/** Camps (projets de l'organisation) : création, renommage, suppression logique, liste. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Deps, requireAuth } from '../app.ts';
import { audit } from '../audit.ts';
import { tx } from '../db.ts';
import { HttpError, notFound } from '../errors.ts';
import { allowedCampIds, requireCampAccess, requirePermission } from '../permissions.ts';
import { expectedVersion, idempotencyKey, logChange, remember, replayed } from '../sync.ts';

export const ID = /^[A-Za-z0-9_-]{6,64}$/;

const campBody = z.object({
  name: z.string().trim().min(1).max(200),
  notes: z.string().max(10_000).default(''),
});

export function registerCampRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/camps', async (request) => {
    const auth = requireAuth(request);
    return tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, async (c) => {
      const allowed = await allowedCampIds(c, auth);
      const r = await c.query(
        `SELECT id, name, notes, server_version AS "serverVersion", created_at AS "createdAt",
                updated_at AS "updatedAt", deleted_at AS "deletedAt"
           FROM camps WHERE organization_id = $1 ORDER BY name`,
        [auth.orgId],
      );
      return { camps: r.rows.filter((row) => !allowed || allowed.has(row.id)) };
    });
  });

  app.put<{ Params: { id: string } }>('/api/camps/:id', async (request, reply) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'camp.write');
    if (!ID.test(request.params.id)) throw notFound('Camp');
    const body = campBody.parse(request.body);
    const expected = expectedVersion(request);
    const key = idempotencyKey(request);
    const route = `PUT camp ${request.params.id}`;
    const result = await tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, async (c) => {
      const again = await replayed(c, auth, key, route);
      if (again) return again;
      const current = (
        await c.query<{ server_version: number; deleted_at: Date | null; name: string }>(
          'SELECT server_version, deleted_at, name FROM camps WHERE organization_id = $2 AND id = $1 FOR UPDATE',
          [request.params.id, auth.orgId],
        )
      ).rows[0];
      let version: number;
      if (!current) {
        if (expected !== 0) throw new HttpError(409, 'deleted', 'Ce camp n’existe plus sur le serveur.');
        version = 1;
        await c.query(
          `INSERT INTO camps (organization_id, id, name, notes, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [auth.orgId, request.params.id, body.name, body.notes, auth.userId],
        );
        await audit(c, {
          orgId: auth.orgId,
          userId: auth.userId,
          action: 'camp.create',
          targetKind: 'camp',
          targetId: request.params.id,
          requestId: request.id,
        });
      } else {
        await requireCampAccess(c, auth, request.params.id);
        if (current.deleted_at) throw new HttpError(409, 'deleted', 'Ce camp a été supprimé sur le serveur.');
        if (expected !== current.server_version)
          throw new HttpError(409, 'version', 'Le camp a été modifié ailleurs.', {
            serverVersion: current.server_version,
          });
        version = current.server_version + 1;
        await c.query(
          'UPDATE camps SET name = $2, notes = $3, updated_by = $4, updated_at = now(), server_version = $5 WHERE organization_id = $6 AND id = $1',
          [request.params.id, body.name, body.notes, auth.userId, version, auth.orgId],
        );
        if (current.name !== body.name)
          await audit(c, {
            orgId: auth.orgId,
            userId: auth.userId,
            action: 'camp.rename',
            targetKind: 'camp',
            targetId: request.params.id,
            requestId: request.id,
          });
      }
      await logChange(c, auth.orgId, 'camp', request.params.id, version);
      const response = { status: current ? 200 : 201, body: { serverVersion: version } };
      await remember(c, auth, key, route, response.status, response.body);
      return response;
    });
    return reply.status(result.status).send(result.body);
  });

  app.delete<{ Params: { id: string } }>('/api/camps/:id', async (request, reply) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'camp.delete');
    const expected = expectedVersion(request);
    const key = idempotencyKey(request);
    const route = `DELETE camp ${request.params.id}`;
    const result = await tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, async (c) => {
      const again = await replayed(c, auth, key, route);
      if (again) return again;
      const current = (
        await c.query<{ server_version: number; deleted_at: Date | null }>(
          'SELECT server_version, deleted_at FROM camps WHERE organization_id = $2 AND id = $1 FOR UPDATE',
          [request.params.id, auth.orgId],
        )
      ).rows[0];
      if (!current) throw notFound('Camp');
      await requireCampAccess(c, auth, request.params.id);
      if (current.deleted_at) return { status: 200, body: { serverVersion: current.server_version } };
      if (expected !== current.server_version)
        throw new HttpError(409, 'version', 'Le camp a été modifié ailleurs.', {
          serverVersion: current.server_version,
        });
      const plans = await c.query(
        'SELECT 1 FROM plans WHERE organization_id = $2 AND camp_id = $1 AND deleted_at IS NULL',
        [request.params.id, auth.orgId],
      );
      if (plans.rowCount) throw new HttpError(409, 'not-empty', 'Supprimez d’abord les plans de ce camp.');
      const version = current.server_version + 1;
      await c.query(
        'UPDATE camps SET deleted_at = now(), server_version = $2, updated_by = $3 WHERE organization_id = $4 AND id = $1',
        [request.params.id, version, auth.userId, auth.orgId],
      );
      await logChange(c, auth.orgId, 'camp', request.params.id, version, true);
      await audit(c, {
        orgId: auth.orgId,
        userId: auth.userId,
        action: 'camp.delete',
        targetKind: 'camp',
        targetId: request.params.id,
        requestId: request.id,
      });
      const response = { status: 200, body: { serverVersion: version } };
      await remember(c, auth, key, route, response.status, response.body);
      return response;
    });
    return reply.status(result.status).send(result.body);
  });
}
