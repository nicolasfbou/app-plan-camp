/**
 * Cartouche des plans officiels. Le statut « Approuvé » n'est JAMAIS attribué automatiquement :
 * il exige un choix explicite, le nom de l'approbateur et une confirmation d'autorisation.
 */
import type { PlanDocument, PlanStatus } from '../model/types.ts';

export const STATUS_LABELS: Record<PlanStatus, string> = {
  draft: 'Brouillon',
  review: 'En révision',
  'field-validation': 'À valider sur le terrain',
  approved: 'Approuvé',
};

export class ApprovalError extends Error {
  override name = 'ApprovalError';
}

/**
 * Change le statut du plan. Pour « Approuvé » : `confirmed` (l'utilisateur atteste être autorisé)
 * et `approvedBy` (non vide) sont obligatoires ; la date d'approbation est enregistrée. Tout autre
 * statut retire l'approbation.
 */
export function setPlanStatus(
  doc: PlanDocument,
  status: PlanStatus,
  approval: { confirmed: boolean; approvedBy: string } | null = null,
  now = new Date().toISOString(),
): void {
  const block = doc.plan.titleBlock;
  if (status === 'approved') {
    if (!approval?.confirmed || !approval.approvedBy.trim())
      throw new ApprovalError('L’approbation exige un approbateur nommé et une confirmation explicite.');
    block.status = 'approved';
    block.approvedBy = approval.approvedBy.trim();
    block.approvedAt = now;
  } else {
    block.status = status;
    block.approvedAt = null;
  }
  doc.plan.updatedAt = now;
}

export interface TitleBlockRow {
  label: string;
  value: string;
}

/** Date affichée (AAAA-MM-JJ du cartouche, sinon la date du jour de l'export), format québécois. */
export function displayDate(value: string, now = new Date()): string {
  const date = value ? new Date(`${value}T12:00:00`) : now;
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

/** Lignes du cartouche (champs vides omis), dans l'ordre d'un cartouche d'ingénierie. */
export function titleBlockRows(
  doc: PlanDocument,
  context: {
    siteName: string;
    scaleText: string;
    northText: string;
    include: { date: boolean; revision: boolean; notes: boolean };
    now?: Date;
  },
): TitleBlockRow[] {
  const b = doc.plan.titleBlock;
  const rows: [string, string][] = [
    ['Camp', b.campName || context.siteName],
    ['Titre', b.title || doc.plan.name],
    ['Client', b.client],
    ['Entreprise', b.company],
    ['Préparé par', b.preparedBy],
    ['Vérifié par', b.checkedBy],
    ['Approuvé par', b.status === 'approved' ? b.approvedBy : ''],
    ['Date', context.include.date ? displayDate(b.date, context.now) : ''],
    ['N° de plan', b.planNumber],
    ['Révision', context.include.revision ? b.revision : ''],
    ['Échelle', context.scaleText],
    ['Nord', context.northText],
    ['Statut', STATUS_LABELS[b.status]],
    ['Notes', context.include.notes ? b.notes : ''],
  ];
  return rows.filter(([, v]) => v.trim() !== '').map(([label, value]) => ({ label, value }));
}
