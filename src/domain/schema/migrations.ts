/**
 * Migrations du format de projet.
 *
 * Chaque entrée `n` transforme un document brut de la version `n` vers la version `n + 1`.
 * Pour faire évoluer le format : incrémenter `SCHEMA_VERSION`, adapter `schema.ts`, puis ajouter
 * ici la migration `SCHEMA_VERSION - 1`, accompagnée d'un test avec un fichier de l'ancienne version.
 */
import { SCHEMA_VERSION } from '../model/schema.ts';

export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;
export type MigrationTable = Readonly<Record<number, Migration>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const MIGRATIONS: MigrationTable = {
  /** 1 → 2 : ajout de `groupId` (null) à chaque objet. Rien d'autre ne change. */
  1: (doc) => {
    const objects = isRecord(doc.objects) ? doc.objects : {};
    return {
      ...doc,
      objects: Object.fromEntries(
        Object.entries(objects).map(([id, object]) => [
          id,
          isRecord(object) ? { groupId: null, ...object } : object,
        ]),
      ),
    };
  },
};

export class ProjectFormatError extends Error {
  override name = 'ProjectFormatError';
}

export function migrateDocument(
  raw: unknown,
  migrations: MigrationTable = MIGRATIONS,
  targetVersion: number = SCHEMA_VERSION,
): Record<string, unknown> {
  if (!isRecord(raw)) throw new ProjectFormatError("Le projet n'est pas un objet JSON valide.");
  const version = raw.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ProjectFormatError('Version du format de projet absente ou invalide.');
  }
  if (version > targetVersion) {
    throw new ProjectFormatError(
      `Ce projet a été créé avec une version plus récente du logiciel (format ${version}, ` +
        `format supporté ${targetVersion}). Mettez l'application à jour pour l'ouvrir.`,
    );
  }
  let doc = raw;
  for (let v = version; v < targetVersion; v++) {
    const migrate = migrations[v];
    if (!migrate) throw new ProjectFormatError(`Migration manquante du format ${v} vers ${v + 1}.`);
    doc = { ...migrate(doc), schemaVersion: v + 1 };
  }
  return doc;
}
