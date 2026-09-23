/**
 * Révisions figées d'un plan (contrôle documentaire).
 *
 * Une révision = des MÉTADONNÉES (numéro, description, auteur, date, raison, statut, approbation,
 * journal des statuts) + un INSTANTANÉ complet et structuré du plan (objets, calques, vues,
 * réglages d'impression, légende, cartouche, référence à la photo et son SHA-256), stocké à part
 * sous forme de texte JSON exact avec son empreinte SHA-256.
 *
 * Règles :
 * - l'instantané n'est JAMAIS modifié (aucune fonction ne le permet ; son empreinte est vérifiée à
 *   chaque lecture) ; pour changer un plan, on crée une nouvelle révision à partir du brouillon ;
 * - la photo n'est jamais copiée : l'instantané la référence (identifiant + SHA-256) ;
 * - « Approuvé » exige un choix explicite, un approbateur nommé et une confirmation ; une révision
 *   approuvée ne peut plus changer (seul le passage à « Archivé » est permis, l'approbation restant
 *   conservée), ni être supprimée ;
 * - un « sceau » (SHA-256 des champs figés et de l'approbation) révèle toute altération.
 */
import { z } from 'zod';
import { sha256Hex } from '../image/hash.ts';
import { idSchema, isoDateSchema, SCHEMA_VERSION } from '../model/schema.ts';
import type { PlanDocument } from '../model/types.ts';
import { serializePlanDocument } from '../schema/serialization.ts';
import type { RevisionHistoryRow, RevisionStamp } from '../print/titleBlock.ts';

/** Version du format des métadonnées de révision (indépendante du schéma du plan). */
export const REVISION_FORMAT_VERSION = 1;

export const REVISION_STATUSES = ['draft', 'review', 'field-validation', 'approved', 'archived'] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

export const REVISION_STATUS_LABELS: Record<RevisionStatus, string> = {
  draft: 'Brouillon',
  review: 'En révision',
  'field-validation': 'À valider sur le terrain',
  approved: 'Approuvé',
  archived: 'Archivé',
};

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ');

export const approvalSchema = z.object({
  by: z.string().trim().min(1),
  /** Date d'approbation (AAAA-MM-JJ). */
  date: dateSchema,
  comment: z.string(),
  /** Moment de l'enregistrement de l'approbation. */
  recordedAt: isoDateSchema,
  /** Personne ayant créé la révision (conservée avec l'approbation). */
  revisionAuthor: z.string(),
  /**
   * Identifiant vérifié de l'approbateur (futur serveur). Absent en usage local : le nom est
   * DÉCLARÉ, jamais attribué à un faux utilisateur global.
   */
  approverUserId: z.string().min(1).optional(),
  /**
   * Nature de l'approbation (scellée avec elle) :
   * - `local_unverified` : approbation locale DÉCLARÉE (nom saisi), identité non vérifiée ;
   * - `authenticated_server` : approbation faite par un compte authentifié, datée et scellée par
   *   le serveur.
   * Absent sur les approbations locales antérieures à la phase 9 : elles sont `local_unverified`
   * (voir `approvalVerification`) et ne sont JAMAIS réécrites ni converties.
   */
  verificationType: z.enum(['local_unverified', 'authenticated_server']).optional(),
});

export type ApprovalVerification = 'local_unverified' | 'authenticated_server';

/** Type de vérification d'une approbation (une approbation ancienne sans type est locale). */
export const approvalVerification = (approval: { verificationType?: ApprovalVerification } | null) =>
  approval ? (approval.verificationType ?? 'local_unverified') : null;

export const statusLogEntrySchema = z.object({
  from: z.enum(REVISION_STATUSES).nullable(),
  to: z.enum(REVISION_STATUSES),
  at: isoDateSchema,
  by: z.string(),
  comment: z.string(),
  /** Identifiant vérifié de la personne (futur serveur) ; absent en usage local. */
  userId: z.string().min(1).optional(),
});

export const changeSummarySchema = z.object({
  /** Révision de comparaison (précédente à la création). */
  sinceLabel: z.string(),
  user: z.number().int().nonnegative(),
  auto: z.number().int().nonnegative(),
  lines: z.array(z.string()),
});

export const revisionMetaSchema = z
  .object({
    format: z.literal('campplan-revision'),
    formatVersion: z.number().int().positive(),
    id: idSchema,
    planId: idSchema,
    label: z.string().trim().min(1).max(20),
    description: z.string(),
    author: z.string().trim().min(1),
    /** Identifiant vérifié de l'auteur (futur serveur) ; absent en usage local. */
    authorUserId: z.string().min(1).optional(),
    /** Date de la révision (AAAA-MM-JJ), imprimée au cartouche. */
    date: dateSchema,
    reason: z.string(),
    comments: z.string(),
    status: z.enum(REVISION_STATUSES),
    approval: approvalSchema.nullable(),
    statusLog: z.array(statusLogEntrySchema),
    createdAt: isoDateSchema,
    /** Révision précédente au moment de la création (null pour la première). */
    parentId: idSchema.nullable(),
    snapshot: z.object({
      sha256: sha256Schema,
      byteLength: z.number().int().positive(),
      schemaVersion: z.number().int().positive(),
      objectCount: z.number().int().nonnegative(),
      layerCount: z.number().int().positive(),
      viewCount: z.number().int().nonnegative(),
      /** Photo référencée (jamais copiée) : nom et empreinte. */
      photo: z.object({ fileName: z.string(), sha256: sha256Schema }).nullable(),
    }),
    /** Changements depuis la révision précédente (calculés une fois, à la création). */
    changes: changeSummarySchema.nullable(),
    /** Empreinte des champs figés, du statut et de l'approbation (détection d'altération). */
    seal: sha256Schema,
  })
  // « Approuvé » exige une approbation ; une approbation n'existe qu'approuvée ou archivée.
  .refine((m) => m.status !== 'approved' || m.approval !== null, {
    message: 'Révision « Approuvé » sans approbation enregistrée.',
  })
  .refine((m) => m.approval === null || m.status === 'approved' || m.status === 'archived', {
    message: 'Approbation incohérente avec le statut de la révision.',
  });

export type RevisionMeta = z.infer<typeof revisionMetaSchema>;

/** Une révision est approuvée si elle porte une approbation (même archivée ensuite). */
export const isApproved = (meta: Pick<RevisionMeta, 'status' | 'approval'>) =>
  meta.approval !== null || meta.status === 'approved';
export type RevisionApproval = z.infer<typeof approvalSchema>;
export type ChangeSummary = z.infer<typeof changeSummarySchema>;

export class RevisionError extends Error {
  override name = 'RevisionError';
}

/** Révision dont l'instantané ou les champs figés ne correspondent plus à leur empreinte. */
export class RevisionIntegrityError extends RevisionError {
  override name = 'RevisionIntegrityError';
}

const encoder = new TextEncoder();
export const sha256OfText = (text: string) => sha256Hex(encoder.encode(text).slice().buffer);

/**
 * Champs couverts par le sceau : tout sauf l'identifiant local, le plan local et la révision
 * précédente (renouvelés par un import en copie). Le sceau est un CONTRÔLE D'INTÉGRITÉ (erreur,
 * fichier endommagé, modification maladroite) : ce n'est pas une signature — sans serveur ni comptes,
 * une personne déterminée pourrait le recalculer.
 */
function sealPayload(meta: Omit<RevisionMeta, 'seal'>): string {
  return JSON.stringify([
    meta.label,
    meta.description,
    meta.author,
    meta.date,
    meta.reason,
    meta.comments,
    meta.createdAt,
    meta.snapshot,
    meta.changes,
    meta.status,
    meta.statusLog,
    meta.approval,
    // Ajouté seulement s'il existe : les sceaux des révisions locales existantes restent valides.
    ...(meta.authorUserId ? [meta.authorUserId] : []),
  ]);
}

export const revisionSeal = (meta: Omit<RevisionMeta, 'seal'>) => sha256OfText(sealPayload(meta));

/** Vrai si le sceau correspond aux champs figés (aucune altération). */
export async function isSealIntact(meta: RevisionMeta): Promise<boolean> {
  return (await revisionSeal(meta)) === meta.seal;
}

/** Numéro suivant : A → B … Z → AA ; 3 → 4 ; sinon « A ». */
export function nextRevisionLabel(existing: readonly string[], fallback = 'A'): string {
  const last = existing.at(-1)?.trim().toUpperCase();
  let candidate = fallback.trim().toUpperCase() || 'A';
  if (last && /^\d+$/.test(last)) candidate = String(Number(last) + 1);
  else if (last && /^[A-Z]+$/.test(last)) {
    const chars = [...last];
    let i = chars.length - 1;
    while (i >= 0 && chars[i] === 'Z') chars[i--] = 'A';
    if (i < 0) chars.unshift('A');
    else chars[i] = String.fromCharCode(chars[i]!.charCodeAt(0) + 1);
    candidate = chars.join('');
  }
  const taken = new Set(existing.map((l) => l.trim().toUpperCase()));
  while (taken.has(candidate)) candidate = `${candidate}'`;
  return candidate;
}

export interface NewRevisionInput {
  label: string;
  description: string;
  author: string;
  date: string;
  reason: string;
  comments: string;
  /** Statut initial : jamais « Approuvé » (l'approbation est une action distincte, explicite). */
  status: Exclude<RevisionStatus, 'approved' | 'archived'>;
  /** Identifiant vérifié de l'auteur, fourni plus tard par un serveur (jamais inventé localement). */
  authorUserId?: string;
}

export interface FrozenRevision {
  meta: RevisionMeta;
  /** Texte JSON exact de l'instantané (celui dont l'empreinte est `meta.snapshot.sha256`). */
  json: string;
}

/**
 * Fige le brouillon : instantané complet (copie profonde sérialisée), métadonnées validées, sceau.
 * Le brouillon n'est pas modifié.
 */
export async function freezeRevision(
  doc: PlanDocument,
  input: NewRevisionInput,
  context: {
    id: string;
    existingLabels: readonly string[];
    parentId: string | null;
    changes: ChangeSummary | null;
    now: string;
  },
): Promise<FrozenRevision> {
  const label = input.label.trim();
  if (!label) throw new RevisionError('Le numéro de révision est obligatoire.');
  if (context.existingLabels.some((l) => l.trim().toUpperCase() === label.toUpperCase()))
    throw new RevisionError(`La révision « ${label} » existe déjà pour ce plan.`);
  if (!input.author.trim()) throw new RevisionError('L’auteur de la révision est obligatoire.');
  if ((input.status as string) === 'approved' || (input.status as string) === 'archived')
    throw new RevisionError(
      'Une révision est créée sans approbation ; l’approbation est une étape distincte.',
    );
  const json = serializePlanDocument(doc);
  const image = doc.plan.baseImage;
  const withoutSeal: Omit<RevisionMeta, 'seal'> = {
    format: 'campplan-revision',
    formatVersion: REVISION_FORMAT_VERSION,
    id: context.id,
    planId: doc.plan.id,
    label,
    description: input.description.trim(),
    author: input.author.trim(),
    ...(input.authorUserId ? { authorUserId: input.authorUserId } : {}),
    date: input.date,
    reason: input.reason.trim(),
    comments: input.comments.trim(),
    status: input.status,
    approval: null,
    statusLog: [{ from: null, to: input.status, at: context.now, by: input.author.trim(), comment: '' }],
    createdAt: context.now,
    parentId: context.parentId,
    snapshot: {
      sha256: await sha256OfText(json),
      byteLength: encoder.encode(json).byteLength,
      schemaVersion: doc.schemaVersion ?? SCHEMA_VERSION,
      objectCount: Object.keys(doc.objects).length,
      layerCount: doc.layers.length,
      viewCount: doc.plan.views.length,
      photo: image ? { fileName: image.fileName, sha256: image.sha256 } : null,
    },
    changes: context.changes,
  };
  const meta = revisionMetaSchema.parse({ ...withoutSeal, seal: await revisionSeal(withoutSeal) });
  return { meta, json };
}

export interface StatusChange {
  to: RevisionStatus;
  /** Nom déclaré de la personne. */
  by: string;
  /** Identifiant vérifié (futur serveur : fourni par l'authentification, jamais par le client). */
  userId?: string;
  comment: string;
  /** Approbation : l'utilisateur atteste être autorisé à approuver. */
  confirmed?: boolean;
  /** Date d'approbation (AAAA-MM-JJ). */
  approvalDate?: string;
  /** Réservé au serveur : approbation par un compte authentifié. Localement : déclarée. */
  verificationType?: ApprovalVerification;
}

/** Statuts accessibles depuis une révision (l'approbation fige tout, sauf l'archivage). */
export function allowedStatuses(meta: RevisionMeta): RevisionStatus[] {
  if (isApproved(meta)) return meta.status === 'approved' ? ['archived'] : [];
  return REVISION_STATUSES.filter((s) => s !== meta.status);
}

/**
 * Nouvel état des métadonnées après un changement de statut (l'instantané n'est pas concerné).
 * Lève `RevisionError` pour toute transition interdite.
 */
export async function changeRevisionStatus(
  meta: RevisionMeta,
  change: StatusChange,
  now: string,
): Promise<RevisionMeta> {
  if (!(await isSealIntact(meta)))
    throw new RevisionIntegrityError(
      `La révision ${meta.label} est altérée : aucun changement n’est permis.`,
    );
  if (!allowedStatuses(meta).includes(change.to))
    throw new RevisionError(
      meta.approval
        ? `La révision ${meta.label} est approuvée : elle ne peut plus être modifiée (seul l’archivage est possible). Créez une nouvelle révision.`
        : `Changement de statut impossible (${REVISION_STATUS_LABELS[meta.status]} → ${REVISION_STATUS_LABELS[change.to]}).`,
    );
  const by = change.by.trim();
  let approval = meta.approval;
  if (change.to === 'approved') {
    if (!change.confirmed || !by)
      throw new RevisionError('L’approbation exige un approbateur nommé et une confirmation explicite.');
    approval = approvalSchema.parse({
      by,
      date: change.approvalDate ?? now.slice(0, 10),
      comment: change.comment.trim(),
      recordedAt: now,
      revisionAuthor: meta.author,
      ...(change.userId ? { approverUserId: change.userId } : {}),
      verificationType: change.verificationType ?? 'local_unverified',
    });
  }
  const next: Omit<RevisionMeta, 'seal'> = {
    ...structuredClone(meta),
    status: change.to,
    approval,
    statusLog: [
      ...meta.statusLog,
      {
        from: meta.status,
        to: change.to,
        at: now,
        by,
        comment: change.comment.trim(),
        ...(change.userId ? { userId: change.userId } : {}),
      },
    ],
  };
  delete (next as Partial<RevisionMeta>).seal;
  return revisionMetaSchema.parse({ ...next, seal: await revisionSeal(next) });
}

/** Une révision approuvée (même archivée ensuite) ne peut jamais être supprimée. */
export const isDeletable = (meta: RevisionMeta) => !isApproved(meta);

/** Figé récursivement : toute tentative de modification d'une révision chargée échoue. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Remplace les identifiants de fichiers de l'instantané par les identifiants locaux (le contenu,
 * identifié par son SHA-256, est le même : un import attribue de nouveaux identifiants).
 */
export function withLocalBlobs(doc: PlanDocument, blobMap: Readonly<Record<string, string>>): PlanDocument {
  const map = (id: string) => blobMap[id] ?? id;
  const image = doc.plan.baseImage;
  return {
    ...doc,
    plan: {
      ...doc.plan,
      baseImage: image
        ? {
            ...image,
            blobId: map(image.blobId),
            source:
              image.source.kind === 'pdf'
                ? { ...image.source, pdfBlobId: map(image.source.pdfBlobId) }
                : image.source,
          }
        : null,
    },
    assets: Object.fromEntries(
      Object.entries(doc.assets).map(([id, a]) => [id, { ...a, blobId: map(a.blobId) }]),
    ),
  };
}

/** Fichiers (photo, PDF d'origine, pictogrammes) référencés par un document. */
export function referencedBlobIds(doc: PlanDocument): string[] {
  const image = doc.plan.baseImage;
  const ids = image
    ? image.source.kind === 'pdf'
      ? [image.blobId, image.source.pdfBlobId]
      : [image.blobId]
    : [];
  for (const asset of Object.values(doc.assets)) ids.push(asset.blobId);
  return [...new Set(ids)];
}

/**
 * Brouillon issu d'une révision : le contenu de l'instantané (copie indépendante), dans le plan
 * courant (même identifiant, même camp, même nom). L'instantané lui-même n'est pas touché.
 */
export function draftFromRevision(
  current: PlanDocument,
  snapshot: PlanDocument,
  meta: Pick<RevisionMeta, 'id' | 'label'>,
  now: string,
): PlanDocument {
  const copy = structuredClone(snapshot) as PlanDocument;
  copy.plan = {
    ...copy.plan,
    id: current.plan.id,
    siteId: current.plan.siteId,
    name: current.plan.name,
    createdAt: current.plan.createdAt,
    variantOf: current.plan.variantOf,
    updatedAt: now,
    draftBase: { revisionId: meta.id, label: meta.label, at: now },
  };
  // Un brouillon n'hérite jamais d'une approbation : elle appartient à la révision figée.
  if (copy.plan.titleBlock.status === 'approved')
    copy.plan.titleBlock = { ...copy.plan.titleBlock, status: 'draft', approvedAt: null };
  return copy;
}

/** Cartouche d'une révision exportée : ses propres numéro, date, auteur, statut et approbation. */
export function revisionStamp(meta: RevisionMeta): RevisionStamp {
  return {
    label: meta.label,
    date: meta.date,
    author: meta.author,
    statusLabel:
      meta.status === 'archived' && meta.approval
        ? 'Archivé (approuvé)'
        : REVISION_STATUS_LABELS[meta.status],
    approved: isApproved(meta),
    approvedBy: meta.approval ? `${meta.approval.by} — ${meta.approval.date}` : '',
  };
}

/**
 * Tableau des révisions imprimé au cartouche : jusqu'à `upTo` comprise (toutes sinon), la plus
 * récente en premier.
 */
export function revisionHistoryRows(metas: readonly RevisionMeta[], upTo?: string): RevisionHistoryRow[] {
  const end = upTo ? metas.findIndex((m) => m.id === upTo) : metas.length - 1;
  return metas
    .slice(0, end + 1)
    .reverse()
    .map((m) => ({ label: m.label, date: m.date, description: m.description, author: m.author }));
}
