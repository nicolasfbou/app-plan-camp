/**
 * Flux des changements de l'organisation depuis un curseur (`seq`) : le client télécharge ensuite
 * ce qui a changé. Vérification préalable d'une publication (identifiants déjà utilisés,
 * fichiers déjà présents), sans rien écrire.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Deps, requireAuth } from '../app.ts';
import { tx } from '../db.ts';
import { allowedCampIds, requirePermission } from '../permissions.ts';

export function registerSyncRoutes(app: FastifyInstance, deps: Deps) {
  app.get<{ Querystring: { since?: string; limit?: string } }>('/api/sync/changes', async (request) => {
    const auth = requireAuth(request);
    const since = Math.max(Number(request.query.since ?? 0) || 0, 0);
    const limit = Math.min(Math.max(Number(request.query.limit ?? 500) || 500, 1), 2000);
    return tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, async (c) => {
      const rows = await c.query<{
        seq: number;
        kind: 'camp' | 'plan' | 'revision' | 'template';
        entity_id: string;
        server_version: number;
        deleted: boolean;
        camp_id: string | null;
      }>(
        `SELECT l.seq, l.kind, l.entity_id, l.server_version, l.deleted,
                CASE l.kind WHEN 'camp' THEN l.entity_id WHEN 'plan' THEN p.camp_id WHEN 'revision' THEN rp.camp_id END AS camp_id
           FROM change_log l
           LEFT JOIN plans p ON l.kind = 'plan' AND p.organization_id = l.organization_id AND p.id = l.entity_id
           LEFT JOIN revisions r ON l.kind = 'revision' AND r.organization_id = l.organization_id AND r.id = l.entity_id
           LEFT JOIN plans rp ON rp.organization_id = r.organization_id AND rp.id = r.plan_id
          WHERE l.organization_id = $3 AND l.seq > $1 ORDER BY l.seq LIMIT $2`,
        [since, limit, auth.orgId],
      );
      const allowed = await allowedCampIds(c, auth);
      const changes = rows.rows
        .filter((r) => !allowed || r.kind === 'template' || (r.camp_id !== null && allowed.has(r.camp_id)))
        .map((r) => ({
          seq: r.seq,
          kind: r.kind,
          id: r.entity_id,
          serverVersion: r.server_version,
          deleted: r.deleted,
        }));
      const last = rows.rows.at(-1)?.seq ?? since;
      return { changes, cursor: last, more: rows.rows.length === limit };
    });
  });

  app.post('/api/publish/check', async (request) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'publish');
    const ids = z.array(z.string().max(64)).max(5000);
    const body = z
      .object({
        campIds: ids.default([]),
        planIds: ids.default([]),
        revisionIds: ids.default([]),
        sha256: z
          .array(z.string().regex(/^[0-9a-f]{64}$/))
          .max(5000)
          .default([]),
      })
      .parse(request.body);
    return tx(deps.pool, { orgId: auth.orgId, userId: auth.userId }, async (c) => {
      const q = async (sql: string, values: string[]) =>
        values.length ? (await c.query<{ id: string }>(sql, [values])).rows.map((r) => r.id) : [];
      return {
        existing: {
          camps: await q('SELECT id FROM camps WHERE id = ANY($1)', body.campIds),
          plans: await q('SELECT id FROM plans WHERE id = ANY($1)', body.planIds),
          revisions: await q('SELECT id FROM revisions WHERE id = ANY($1)', body.revisionIds),
        },
        presentFiles: await q('SELECT sha256 AS id FROM files WHERE sha256 = ANY($1)', body.sha256),
      };
    });
  });
}
