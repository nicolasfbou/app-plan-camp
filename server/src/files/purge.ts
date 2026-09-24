/**
 * Maintenance : suppression des fichiers JAMAIS référencés (envoi abandonné, import annulé).
 *
 * Règles de protection :
 * - un fichier cité par un plan (n'importe quelle version de son historique), une révision ou un
 *   modèle a une référence (`file_refs`, cumulée, jamais retirée par l'application) : il n'est
 *   JAMAIS supprimé, même si le plan est supprimé (suppression logique : restauration possible) ;
 * - délai de grâce (24 h par défaut) : un fichier envoyé juste avant le plan qui le cite n'est pas
 *   supprimé entre les deux envois ;
 * - verrou par fichier (organisation, empreinte), partagé avec l'envoi : la ligne puis l'objet
 *   sont supprimés SOUS ce verrou, avant la validation. Un envoi simultané du même fichier attend,
 *   puis recrée ligne et objet ; si l'objet ne peut être supprimé, la ligne est conservée.
 * S'exécute avec le rôle PROPRIÉTAIRE (toutes les organisations) : `MIGRATION_DATABASE_URL`.
 */
import type pg from 'pg';
import type { ObjectStorage } from '../storage/storage.ts';

/** Verrou transactionnel d'un fichier : envoi et nettoyage du même fichier sont sérialisés. */
export async function lockFile(c: pg.ClientBase, organizationId: string, sha256: string): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`file:${organizationId}:${sha256}`]);
}

export interface PurgeResult {
  removed: { organizationId: string; sha256: string; bytes: number }[];
  errors: string[];
}

export async function purgeUnusedFiles(
  owner: pg.Pool,
  storage: ObjectStorage,
  { graceHours = 24, dryRun = false } = {},
): Promise<PurgeResult> {
  const result: PurgeResult = { removed: [], errors: [] };
  const candidates = await owner.query<{
    organization_id: string;
    sha256: string;
    storage_key: string;
    byte_length: number;
  }>(
    `SELECT f.organization_id, f.sha256, f.storage_key, f.byte_length FROM files f
      WHERE f.created_at < now() - make_interval(hours => $1)
        AND NOT EXISTS (SELECT 1 FROM file_refs r
                         WHERE r.organization_id = f.organization_id AND r.sha256 = f.sha256)`,
    [graceHours],
  );
  for (const file of candidates.rows) {
    if (dryRun) {
      result.removed.push({
        organizationId: file.organization_id,
        sha256: file.sha256,
        bytes: file.byte_length,
      });
      continue;
    }
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await lockFile(client, file.organization_id, file.sha256);
      // Revérifié sous verrou : une référence ajoutée entre-temps protège le fichier.
      const gone = await client.query(
        `DELETE FROM files f WHERE f.organization_id = $1 AND f.sha256 = $2
            AND NOT EXISTS (SELECT 1 FROM file_refs r WHERE r.organization_id = $1 AND r.sha256 = $2)`,
        [file.organization_id, file.sha256],
      );
      if (gone.rowCount) {
        await client.query("SELECT set_config('app.org_id', $1, true)", [file.organization_id]);
        await client.query(
          `INSERT INTO audit_events (organization_id, user_id, action, target_kind, target_id, context)
           VALUES ($1, NULL, 'file.purge', 'file', $2, $3)`,
          [
            file.organization_id,
            file.sha256,
            JSON.stringify({ bytes: file.byte_length, reason: 'jamais référencé' }),
          ],
        );
      }
      // Objet supprimé AVANT la validation, verrou tenu : en cas d'échec, la ligne est rétablie.
      if (gone.rowCount) await storage.delete(file.storage_key);
      await client.query('COMMIT');
      if (gone.rowCount) {
        result.removed.push({
          organizationId: file.organization_id,
          sha256: file.sha256,
          bytes: file.byte_length,
        });
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      result.errors.push(`${file.sha256} : ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.release();
    }
  }
  return result;
}
