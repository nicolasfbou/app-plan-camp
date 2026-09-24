/**
 * Fichiers accessibles à la session. Organisation : toujours celle de la session. Accès restreint
 * à certains camps : seulement les fichiers
 * - cités par un plan ou une révision de ces camps, ou par un modèle de l'organisation ;
 * - ou envoyés par la personne elle-même (elle en possède les octets : premier envoi, ou envoi
 *   identique dédoublonné, tracé dans l'audit).
 * Un fichier hors de portée est traité comme ABSENT (jamais de 403 qui révélerait son existence).
 */
import type { Client } from '../db.ts';
import { allowedCampIds, type Auth } from '../permissions.ts';

export async function reachableShas(c: Client, auth: Auth, shas: string[]): Promise<Set<string>> {
  if (!shas.length) return new Set();
  const allowed = await allowedCampIds(c, auth);
  const rows = await c.query<{ sha256: string }>(
    `SELECT f.sha256 FROM files f
      WHERE f.organization_id = $2 AND f.sha256 = ANY($1)
        AND ($3::text[] IS NULL
          OR f.created_by = $4
          OR EXISTS (SELECT 1 FROM audit_events a
                      WHERE a.organization_id = f.organization_id AND a.action = 'file.upload'
                        AND a.target_id = f.sha256 AND a.user_id = $4)
          OR EXISTS (SELECT 1 FROM file_refs r
                       LEFT JOIN plans p ON r.owner_kind = 'plan' AND p.organization_id = r.organization_id AND p.id = r.owner_id
                       LEFT JOIN revisions v ON r.owner_kind = 'revision' AND v.organization_id = r.organization_id AND v.id = r.owner_id
                       LEFT JOIN plans vp ON vp.organization_id = v.organization_id AND vp.id = v.plan_id
                      WHERE r.organization_id = f.organization_id AND r.sha256 = f.sha256
                        AND (r.owner_kind = 'template' OR p.camp_id = ANY($3) OR vp.camp_id = ANY($3))))`,
    [shas, auth.orgId, allowed ? [...allowed] : null, auth.userId],
  );
  return new Set(rows.rows.map((r) => r.sha256.trim()));
}
