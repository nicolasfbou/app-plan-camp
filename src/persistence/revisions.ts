/**
 * Opérations de révision qui combinent le dépôt et le domaine : création d'une révision à partir du
 * brouillon (avec le résumé des changements depuis la précédente).
 */
import { newId, nowIso } from '@/domain/model/factories.ts';
import type { PlanDocument } from '@/domain/model/types.ts';
import { changeSummary, diffPlans } from '@/domain/revisions/diff.ts';
import {
  type ChangeSummary,
  freezeRevision,
  type NewRevisionInput,
  RevisionIntegrityError,
  type RevisionMeta,
} from '@/domain/revisions/revision.ts';
import type { ProjectRepository } from './ProjectRepository.ts';

/** Révisions lisibles d'un plan (métadonnées), dans l'ordre de création. */
export async function revisionMetas(repo: ProjectRepository, planId: string): Promise<RevisionMeta[]> {
  return (await repo.listRevisions(planId)).flatMap((e) => (e.meta ? [e.meta] : []));
}

/**
 * Fige le brouillon `doc` en une nouvelle révision. Le brouillon n'est pas modifié (l'appelant
 * enregistre ensuite, s'il le souhaite, le lien `plan.draftBase`).
 */
export async function createRevisionFromDraft(
  repo: ProjectRepository,
  doc: PlanDocument,
  input: NewRevisionInput,
  now = nowIso(),
): Promise<RevisionMeta> {
  const entries = await repo.listRevisions(doc.plan.id);
  const metas = entries.flatMap((e) => (e.meta ? [e.meta] : []));
  const parent = metas.at(-1) ?? null;
  let changes: ChangeSummary | null = null;
  if (parent) {
    try {
      const previous = await repo.loadRevision(parent.id);
      changes = changeSummary(
        diffPlans(previous.doc, doc, {
          beforeRevisionId: parent.id,
          schemaVersions: { before: parent.snapshot.schemaVersion, after: doc.schemaVersion },
        }),
        parent.label,
      );
    } catch (error) {
      // Révision précédente altérée : la nouvelle est créée, sans résumé (jamais un résumé faux).
      if (!(error instanceof RevisionIntegrityError)) throw error;
    }
  }
  const frozen = await freezeRevision(doc, input, {
    id: newId(),
    existingLabels: metas.map((m) => m.label),
    parentId: parent?.id ?? null,
    changes,
    now,
  });
  await repo.createRevision(frozen);
  return frozen.meta;
}
