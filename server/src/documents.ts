/** Validation serveur d'un document de plan (même code de domaine que le client). */
import { createHash } from 'node:crypto';
import type { PlanDocument } from '@/domain/model/types.ts';
import { parsePlanDocument, serializePlanDocument } from '@/domain/schema/serialization.ts';
import { HttpError } from './errors.ts';

export const sha256Text = (text: string) => createHash('sha256').update(text).digest('hex');

/** Document validé (migré au format courant) + texte canonique + empreinte. */
export function validatePlanDocument(input: unknown): { doc: PlanDocument; json: string; sha256: string } {
  let doc: PlanDocument;
  try {
    doc = parsePlanDocument(input);
  } catch (error) {
    throw new HttpError(
      422,
      'invalid-document',
      `Document de plan invalide : ${error instanceof Error ? error.message.slice(0, 300) : 'erreur'}`,
    );
  }
  const json = serializePlanDocument(doc);
  return { doc, json, sha256: sha256Text(json) };
}

/** Empreintes des fichiers référencés : photo (et PDF d'origine), pictogrammes, logo. */
export function referencedShas(doc: PlanDocument): string[] {
  const image = doc.plan.baseImage;
  const shas = image ? [image.sha256, ...(image.source.kind === 'pdf' ? [image.source.pdfSha256] : [])] : [];
  for (const asset of Object.values(doc.assets)) shas.push(asset.sha256);
  return [...new Set(shas)];
}
