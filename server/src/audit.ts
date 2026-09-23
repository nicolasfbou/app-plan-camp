/**
 * Journal d'audit serveur (ajout seul, garanti par la base). Toujours écrit dans la MÊME
 * transaction que l'action auditée : pas d'action sans trace, pas de trace sans action.
 * Contexte MINIMAL : jamais le document, la photo, un mot de passe ou un jeton.
 */
import type { Client } from './db.ts';

export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'member.invite'
  | 'member.join'
  | 'member.role'
  | 'member.disable'
  | 'member.enable'
  | 'camp.create'
  | 'camp.rename'
  | 'camp.delete'
  | 'plan.create'
  | 'plan.import'
  | 'plan.publish'
  | 'plan.update'
  | 'plan.delete'
  | 'plan.restore'
  | 'revision.create'
  | 'revision.status'
  | 'revision.approve'
  | 'revision.archive'
  | 'revision.delete'
  | 'file.upload'
  | 'template.create'
  | 'template.update'
  | 'template.delete';

export async function audit(
  client: Client,
  entry: {
    orgId: string;
    userId: string | null;
    action: AuditAction;
    targetKind: string;
    targetId: string;
    requestId?: string;
    context?: Record<string, unknown>;
  },
) {
  await client.query(
    `INSERT INTO audit_events (organization_id, user_id, action, target_kind, target_id, request_id, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.orgId,
      entry.userId,
      entry.action,
      entry.targetKind,
      entry.targetId,
      entry.requestId ?? null,
      JSON.stringify(entry.context ?? {}),
    ],
  );
}
