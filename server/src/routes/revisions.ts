/**
 * Révisions côté serveur.
 * - Création : métadonnées + instantané EXACT, revérifiés (schéma, SHA-256, sceau, plan, fichiers).
 *   Jamais de champ d'identité vérifiée fourni par le client (userId), jamais d'approbation
 *   « authentifiée » venue du client. Chaîne scellée : chaque révision est liée au sceau de la
 *   précédente (`chain_hash`), calculé par le serveur.
 * - Approbation : compte authentifié + rôle + date SERVEUR ; sceau recalculé par le serveur ;
 *   révision + audit dans la MÊME transaction.
 * - Immuabilité d'une révision approuvée : API + déclencheur SQL (même contre une requête directe).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  approvalVerification,
  changeRevisionStatus,
  isApproved,
  isSealIntact,
  REVISION_STATUSES,
  revisionMetaSchema,
  RevisionError,
  type RevisionMeta,
} from '@/domain/revisions/revision.ts';
import { type Deps, requireAuth } from '../app.ts';
import { audit } from '../audit.ts';
import { type Client, tx } from '../db.ts';
import { referencedShas, sha256Text, validatePlanDocument } from '../documents.ts';
import { HttpError, notFound } from '../errors.ts';
import { type Auth, can, requireCampAccess, requirePermission } from '../permissions.ts';
import { logChange } from '../sync.ts';
import { ID } from './camps.ts';

const createBody = z.object({
  planId: z.string().regex(ID),
  meta: z.unknown(),
  snapshot: z.string().max(50_000_000),
});
const statusBody = z.object({
  to: z.enum(REVISION_STATUSES),
  comment: z.string().max(2000).default(''),
  confirmed: z.boolean().default(false),
});

interface RevisionRow {
  id: string;
  plan_id: string;
  meta: RevisionMeta;
  status: string;
  verification_type: string | null;
  approved_at: Date | null;
  approved_by: string | null;
  approver_name: string | null;
  chain_hash: string;
  parent_id: string | null;
  created_at: Date;
  created_by_name: string;
  deleted_at: Date | null;
  camp_id: string;
}

const SELECT = `SELECT r.id, r.plan_id, r.meta, r.status, r.verification_type, r.approved_at, r.approved_by,
       a.display_name AS approver_name, r.chain_hash, r.parent_id, r.created_at, cb.display_name AS created_by_name,
       r.deleted_at, p.camp_id
  FROM revisions r JOIN plans p ON p.organization_id = r.organization_id AND p.id = r.plan_id
  JOIN users cb ON cb.id = r.created_by LEFT JOIN users a ON a.id = r.approved_by`;

const view = (r: RevisionRow) => ({
  id: r.id,
  planId: r.plan_id,
  meta: r.meta,
  verificationType: r.verification_type,
  approvedAt: r.approved_at?.toISOString() ?? null,
  approvedBy: r.approved_by ? { id: r.approved_by, name: r.approver_name } : null,
  chainHash: r.chain_hash,
  parentId: r.parent_id,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by_name,
  deleted: r.deleted_at !== null,
});

async function revisionRow(c: Client, auth: Auth, id: string, lock = false) {
  if (!ID.test(id)) return undefined;
  const row = (await c.query<RevisionRow>(`${SELECT} WHERE r.id = $1${lock ? ' FOR UPDATE OF r' : ''}`, [id]))
    .rows[0];
  if (row) await requireCampAccess(c, auth, row.camp_id);
  return row;
}

/** Champs d'identité vérifiée : réservés au serveur, refusés s'ils viennent du client. */
function rejectClientIdentity(meta: RevisionMeta, auth: Auth) {
  if (meta.authorUserId && meta.authorUserId !== auth.userId)
    throw new HttpError(422, 'forged-identity', 'Identifiant d’auteur non vérifiable : refusé.');
  if (meta.statusLog.some((e) => e.userId) || meta.approval?.approverUserId)
    throw new HttpError(422, 'forged-identity', 'Identité vérifiée fournie par le client : refusée.');
  if (meta.approval?.verificationType === 'authenticated_server')
    throw new HttpError(
      422,
      'forged-approval',
      'Une approbation authentifiée ne peut être faite que par le serveur (compte connecté).',
    );
}

/**
 * Historique de statut apporté par le client. Sans droit de publication (éditeur) : seule une
 * révision TELLE QUE CRÉÉE est acceptée (brouillon, en revue ou validation terrain ; une seule
 * entrée d'historique ; aucune approbation). Les historiques plus riches (approbations locales
 * déclarées) ne viennent que de la publication d'un projet local, par un rôle autorisé, et
 * restent « non vérifiés ».
 */
function rejectUnauthorizedHistory(meta: RevisionMeta, auth: Auth) {
  if (can(auth.role, 'publish')) return;
  if (
    meta.approval ||
    meta.status === 'approved' ||
    meta.status === 'archived' ||
    meta.statusLog.length !== 1 ||
    meta.statusLog[0]!.to !== meta.status
  )
    throw new HttpError(
      403,
      'forbidden',
      'Votre rôle permet de créer une révision, pas de lui donner un statut ou une approbation.',
    );
}

export function registerRevisionRoutes(app: FastifyInstance, deps: Deps) {
  const ctx = (auth: Auth) => ({ orgId: auth.orgId, userId: auth.userId });

  app.get<{ Params: { id: string } }>('/api/plans/:id/revisions', async (request) => {
    const auth = requireAuth(request);
    return tx(deps.pool, ctx(auth), async (c) => {
      const plan = await c.query<{ camp_id: string }>('SELECT camp_id FROM plans WHERE id = $1', [
        request.params.id,
      ]);
      if (!plan.rows[0]) throw notFound('Plan');
      await requireCampAccess(c, auth, plan.rows[0].camp_id);
      const rows = await c.query<RevisionRow>(`${SELECT} WHERE r.plan_id = $1 ORDER BY r.created_at, r.id`, [
        request.params.id,
      ]);
      return { revisions: rows.rows.map(view) };
    });
  });

  app.get<{ Params: { id: string } }>('/api/revisions/:id', async (request) => {
    const auth = requireAuth(request);
    return tx(deps.pool, ctx(auth), async (c) => {
      const row = await revisionRow(c, auth, request.params.id);
      if (!row) throw notFound('Révision');
      const snap = await c.query<{ json: string }>(
        'SELECT json FROM revision_snapshots WHERE revision_id = $1',
        [row.id],
      );
      return { ...view(row), snapshot: snap.rows[0]!.json };
    });
  });

  app.put<{ Params: { id: string } }>(
    '/api/revisions/:id',
    { bodyLimit: 60_000_000 },
    async (request, reply) => {
      const auth = requireAuth(request);
      requirePermission(auth, 'revision.create');
      if (!ID.test(request.params.id)) throw notFound('Révision');
      const body = createBody.parse(request.body);
      const parsed = revisionMetaSchema.safeParse(body.meta);
      if (!parsed.success) throw new HttpError(422, 'invalid-revision', 'Métadonnées de révision invalides.');
      const meta = parsed.data;
      if (meta.id !== request.params.id || meta.planId !== body.planId)
        throw new HttpError(422, 'invalid-revision', 'Identifiants de révision incohérents.');
      // Instantané : texte EXACT, empreinte et taille conformes, document valide ; sceau intact.
      if (
        sha256Text(body.snapshot) !== meta.snapshot.sha256 ||
        Buffer.byteLength(body.snapshot) !== meta.snapshot.byteLength
      )
        throw new HttpError(
          422,
          'snapshot-mismatch',
          'Instantané différent de son empreinte : révision refusée.',
        );
      let raw: unknown;
      try {
        raw = JSON.parse(body.snapshot);
      } catch {
        throw new HttpError(422, 'invalid-revision', 'Instantané illisible : révision refusée.');
      }
      const { doc } = validatePlanDocument(raw);
      if (doc.plan.id !== body.planId)
        throw new HttpError(422, 'invalid-revision', 'L’instantané ne correspond pas à ce plan.');
      if (!(await isSealIntact(meta)))
        throw new HttpError(422, 'seal-broken', 'Sceau de la révision invalide : refusée.');
      rejectClientIdentity(meta, auth);
      rejectUnauthorizedHistory(meta, auth);
      const status = await tx(deps.pool, ctx(auth), async (c) => {
        const existing = await revisionRow(c, auth, meta.id, true);
        if (existing) {
          // Idempotent : la même révision renvoyée ne crée rien ; une révision différente est refusée.
          const same =
            existing.meta.seal === meta.seal && existing.meta.snapshot.sha256 === meta.snapshot.sha256;
          if (!same)
            throw new HttpError(409, 'revision-exists', 'Une autre révision porte déjà cet identifiant.');
          return 200;
        }
        // Verrou du plan : deux révisions simultanées ne choisissent ni le même libellé ni le même
        // parent (la chaîne reste linéaire). Index unique en dernier rempart.
        const plan = await c.query<{ camp_id: string; deleted_at: Date | null }>(
          'SELECT camp_id, deleted_at FROM plans WHERE id = $1 FOR UPDATE',
          [body.planId],
        );
        if (!plan.rows[0])
          throw new HttpError(409, 'plan-missing', 'Plan absent du serveur : envoyez-le d’abord.');
        await requireCampAccess(c, auth, plan.rows[0].camp_id);
        const labels = await c.query<{ label: string }>(
          'SELECT label FROM revisions WHERE plan_id = $1 AND deleted_at IS NULL',
          [body.planId],
        );
        if (labels.rows.some((r) => r.label.toUpperCase() === meta.label.toUpperCase()))
          throw new HttpError(
            409,
            'label-taken',
            `La révision ${meta.label} existe déjà sur le serveur pour ce plan.`,
          );
        const shas = referencedShas(doc);
        const present = await c.query<{ sha256: string }>('SELECT sha256 FROM files WHERE sha256 = ANY($1)', [
          shas,
        ]);
        const missing = shas.filter((s) => !present.rows.some((r) => r.sha256 === s));
        if (missing.length)
          throw new HttpError(422, 'missing-files', 'Fichiers absents du serveur.', { missing });
        const parent = (
          await c.query<{ id: string; seal: string; chain_hash: string }>(
            'SELECT id, seal, chain_hash FROM revisions WHERE plan_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
            [body.planId],
          )
        ).rows[0];
        const chainHash = sha256Text(`${parent?.chain_hash ?? ''}|${meta.seal}`);
        await c.query(
          `INSERT INTO revisions (organization_id, id, plan_id, label, meta, snapshot_sha256, seal, status,
                                verification_type, parent_id, parent_seal, chain_hash, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            auth.orgId,
            meta.id,
            body.planId,
            meta.label,
            JSON.stringify(meta),
            meta.snapshot.sha256,
            meta.seal,
            meta.status,
            // Approbation publiée depuis un projet local : conservée, mais NON vérifiée (jamais officielle).
            approvalVerification(meta.approval),
            parent?.id ?? null,
            parent?.seal ?? null,
            chainHash,
            auth.userId,
          ],
        );
        await c.query(
          'INSERT INTO revision_snapshots (organization_id, revision_id, json) VALUES ($1, $2, $3)',
          [auth.orgId, meta.id, body.snapshot],
        );
        for (const s of shas)
          await c.query(
            "INSERT INTO file_refs (organization_id, sha256, owner_kind, owner_id) VALUES ($1, $2, 'revision', $3) ON CONFLICT DO NOTHING",
            [auth.orgId, s, meta.id],
          );
        await logChange(c, auth.orgId, 'revision', meta.id, meta.statusLog.length);
        await audit(c, {
          orgId: auth.orgId,
          userId: auth.userId,
          action: 'revision.create',
          targetKind: 'revision',
          targetId: meta.id,
          requestId: request.id,
          context: {
            planId: body.planId,
            label: meta.label,
            status: meta.status,
            ...(meta.approval ? { approval: 'local_unverified' } : {}),
          },
        });
        return 201;
      });
      return reply.status(status).send({ id: meta.id });
    },
  );

  app.post<{ Params: { id: string } }>('/api/revisions/:id/status', async (request) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'revision.status');
    const body = statusBody.parse(request.body);
    if (body.to === 'approved') requirePermission(auth, 'revision.approve');
    return tx(deps.pool, ctx(auth), async (c) => {
      const row = await revisionRow(c, auth, request.params.id, true);
      if (!row || row.deleted_at) throw notFound('Révision');
      // Intégrité de l'instantané revérifiée avant tout changement de statut.
      const snap = await c.query<{ json: string }>(
        'SELECT json FROM revision_snapshots WHERE revision_id = $1',
        [row.id],
      );
      if (sha256Text(snap.rows[0]!.json) !== row.meta.snapshot.sha256)
        throw new HttpError(409, 'snapshot-altered', 'Instantané altéré : aucun changement permis.');
      const now = (await c.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now;
      let next: RevisionMeta;
      try {
        next = await changeRevisionStatus(
          row.meta,
          {
            to: body.to,
            by: auth.displayName, // nom FIGÉ au moment de l'action
            userId: auth.userId,
            comment: body.comment,
            confirmed: body.confirmed,
            approvalDate: now.toISOString().slice(0, 10),
            verificationType: 'authenticated_server',
          },
          now.toISOString(),
        );
      } catch (error) {
        if (error instanceof RevisionError) throw new HttpError(409, 'status-refused', error.message);
        throw error;
      }
      const approving = body.to === 'approved';
      await c.query(
        `UPDATE revisions SET meta = $2, seal = $3, status = $4,
                verification_type = CASE WHEN $5 THEN 'authenticated_server' ELSE verification_type END,
                approved_at = CASE WHEN $5 THEN $6::timestamptz ELSE approved_at END,
                approved_by = CASE WHEN $5 THEN $7::uuid ELSE approved_by END
          WHERE id = $1`,
        [row.id, JSON.stringify(next), next.seal, next.status, approving, now, auth.userId],
      );
      await logChange(c, auth.orgId, 'revision', row.id, next.statusLog.length);
      await audit(c, {
        orgId: auth.orgId,
        userId: auth.userId,
        action: approving
          ? 'revision.approve'
          : body.to === 'archived'
            ? 'revision.archive'
            : 'revision.status',
        targetKind: 'revision',
        targetId: row.id,
        requestId: request.id,
        context: {
          planId: row.plan_id,
          label: row.meta.label,
          from: row.meta.status,
          to: next.status,
          ...(approving ? { approverName: auth.displayName, serverDate: now.toISOString() } : {}),
        },
      });
      const updated = (await revisionRow(c, auth, row.id))!;
      return view(updated);
    });
  });

  app.delete<{ Params: { id: string } }>('/api/revisions/:id', async (request) => {
    const auth = requireAuth(request);
    requirePermission(auth, 'revision.delete');
    return tx(deps.pool, ctx(auth), async (c) => {
      const row = await revisionRow(c, auth, request.params.id, true);
      if (!row) throw notFound('Révision');
      if (isApproved(row.meta))
        throw new HttpError(
          409,
          'approved-immutable',
          'Une révision approuvée ne peut jamais être supprimée.',
        );
      if (row.deleted_at) return { ok: true };
      await c.query('UPDATE revisions SET deleted_at = now() WHERE id = $1', [row.id]);
      await logChange(c, auth.orgId, 'revision', row.id, row.meta.statusLog.length, true);
      await audit(c, {
        orgId: auth.orgId,
        userId: auth.userId,
        action: 'revision.delete',
        targetKind: 'revision',
        targetId: row.id,
        requestId: request.id,
        context: { label: row.meta.label },
      });
      return { ok: true };
    });
  });
}
