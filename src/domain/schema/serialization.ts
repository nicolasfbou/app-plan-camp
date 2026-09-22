import { planDocumentSchema } from '../model/schema.ts';
import type { PlanDocument } from '../model/types.ts';
import { MIGRATIONS, type MigrationTable, ProjectFormatError, migrateDocument } from './migrations.ts';

export function serializePlanDocument(doc: PlanDocument): string {
  return JSON.stringify(doc);
}

/**
 * Lit un document de plan (texte JSON ou objet déjà désérialisé), applique les migrations,
 * valide la structure et les invariants de référence. Lève `ProjectFormatError` sinon.
 */
export function parsePlanDocument(
  input: string | unknown,
  migrations: MigrationTable = MIGRATIONS,
): PlanDocument {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new ProjectFormatError('Le fichier de projet est illisible (JSON invalide).');
    }
  }
  const result = planDocumentSchema.safeParse(migrateDocument(raw, migrations));
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? ` (${first.path.join('.')})` : '';
    throw new ProjectFormatError(`Projet invalide${where} : ${first?.message ?? 'structure inattendue'}.`);
  }
  assertInvariants(result.data);
  return result.data;
}

function assertInvariants(doc: PlanDocument): void {
  const layerIds = new Set<string>();
  for (const layer of doc.layers) {
    if (layerIds.has(layer.id)) throw new ProjectFormatError(`Calque en double : ${layer.id}.`);
    layerIds.add(layer.id);
  }
  for (const [key, object] of Object.entries(doc.objects)) {
    if (object.id !== key) throw new ProjectFormatError(`Identifiant d'objet incohérent : ${key}.`);
    if (!layerIds.has(object.layerId)) {
      throw new ProjectFormatError(`L'objet ${key} référence un calque inexistant (${object.layerId}).`);
    }
  }
}
