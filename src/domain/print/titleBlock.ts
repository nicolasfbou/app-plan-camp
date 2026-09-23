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
  /** Petit tableau (première ligne = en-tête), ex. l'historique des révisions. */
  table?: string[][];
}

/** Révision figée imprimée au cartouche (les champs du brouillon sont remplacés). */
export interface RevisionStamp {
  label: string;
  /** AAAA-MM-JJ. */
  date: string;
  author: string;
  statusLabel: string;
  approved: boolean;
  /** Approbateur et date d'approbation (vide si jamais approuvée). */
  approvedBy: string;
}

/** Ligne du tableau des révisions (la plus récente en premier). */
export interface RevisionHistoryRow {
  label: string;
  date: string;
  description: string;
  author: string;
}

/** Nombre maximal de révisions imprimées dans le tableau compact. */
export const MAX_HISTORY_ROWS = 6;

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
    /** Titre imprimé (vue par public) ; sinon celui du cartouche ou du plan. */
    title?: string;
    /** Public visé par la vue (ex. « Destiné aux fournisseurs »). */
    audience?: string;
    /** Export d'une révision figée : numéro, date, auteur, statut et approbation de la révision. */
    revision?: RevisionStamp;
    /** Tableau compact des révisions (la plus récente en premier). */
    history?: RevisionHistoryRow[];
  },
): TitleBlockRow[] {
  const b = doc.plan.titleBlock;
  const r = context.revision;
  // Brouillon d'un plan sous révisions : l'approbation porte sur les révisions figées seulement.
  const planApproved = b.status === 'approved' && !doc.plan.draftBase;
  const rows: [string, string][] = [
    ['Camp', b.campName || context.siteName],
    ['Titre', context.title || b.title || doc.plan.name],
    ['Destinataires', context.audience ?? ''],
    ['Client', b.client],
    ['Entreprise', b.company],
    ['Préparé par', b.preparedBy],
    ['Auteur', r ? r.author : ''],
    ['Vérifié par', b.checkedBy],
    ['Approuvé par', r ? r.approvedBy : planApproved ? b.approvedBy : ''],
    ['Date', context.include.date ? displayDate(r ? r.date : b.date, context.now) : ''],
    ['N° de plan', b.planNumber],
    [
      'Révision',
      !context.include.revision
        ? ''
        : r
          ? r.label
          : doc.plan.draftBase && context.history?.length
            ? `${b.revision ? `${b.revision} — ` : ''}brouillon (après rév. ${doc.plan.draftBase.label})`
            : b.revision,
    ],
    ['Échelle', context.scaleText],
    ['Nord', context.northText],
    [
      'Statut',
      r
        ? r.statusLabel
        : b.status === 'approved' && !planApproved
          ? `${STATUS_LABELS.draft} (non approuvé)`
          : STATUS_LABELS[b.status],
    ],
    ['Notes', context.include.notes ? b.notes : ''],
  ];
  const result: TitleBlockRow[] = rows
    .filter(([, v]) => v.trim() !== '')
    .map(([label, value]) => ({ label, value }));
  const history = context.include.revision ? (context.history ?? []) : [];
  if (history.length) {
    const shown = history.slice(0, MAX_HISTORY_ROWS);
    const table = [
      ['Rév.', 'Date', 'Description', 'Préparé par'],
      ...shown.map((h) => [h.label, h.date, h.description || '—', h.author]),
    ];
    if (history.length > shown.length)
      table.push(['…', '', `${history.length - shown.length} révision(s) antérieure(s)`, '']);
    // Avant les notes : ce sont les notes qui cèdent la place en premier.
    const notes = result.findIndex((row) => row.label === 'Notes');
    result.splice(notes >= 0 ? notes : result.length, 0, { label: 'Révisions', value: '', table });
  }
  return result;
}
