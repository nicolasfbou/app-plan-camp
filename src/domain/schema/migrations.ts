/**
 * Migrations du format de projet.
 *
 * Chaque entrée `n` transforme un document brut de la version `n` vers la version `n + 1`.
 * Pour faire évoluer le format : incrémenter `SCHEMA_VERSION`, adapter `schema.ts`, puis ajouter
 * ici la migration `SCHEMA_VERSION - 1`, accompagnée d'un test avec un fichier de l'ancienne version.
 */
import { newId } from '../model/factories.ts';
import { DEFAULT_STYLE, planDefaults } from '../model/planDefaults.ts';
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

  /**
   * 2 → 3 (phase 4) : nouvelles catégories de calques (un calque Stationnement, Livraison et
   * Sécurité est ajouté juste au-dessus des zones s'il n'en existe pas), nouveaux champs des
   * trajets, corridors, pictogrammes et zones (valeurs neutres : rien ne change à l'affichage),
   * pictogrammes importés, suivi des croisements, limites d'affichage. Géométries inchangées.
   */
  2: (doc) => {
    const plan = isRecord(doc.plan) ? doc.plan : {};
    const layers = Array.isArray(doc.layers) ? [...(doc.layers as unknown[])] : [];
    const tiers = new Set(layers.map((l) => (isRecord(l) ? l.tier : undefined)));
    const lastZones = layers.reduce<number>((at, l, i) => (isRecord(l) && l.tier === 'zones' ? i : at), -1);
    const added = NEW_LAYERS_V3.filter(([tier]) => !tiers.has(tier)).map(([tier, name]) => ({
      id: newId(),
      name,
      tier,
      visible: true,
      locked: false,
      opacity: 1,
    }));
    layers.splice(lastZones + 1, 0, ...added);
    const objects = isRecord(doc.objects) ? doc.objects : {};
    return {
      ...doc,
      plan: { display: { symbolMinPx: 12, symbolMaxPx: 44 }, ...plan },
      layers,
      objects: Object.fromEntries(Object.entries(objects).map(([id, o]) => [id, migrateObjectV3(o)])),
      assets: isRecord(doc.assets) ? doc.assets : {},
      crossingReviews: Array.isArray(doc.crossingReviews) ? doc.crossingReviews : [],
    };
  },

  3: (doc) => migrateV3(doc),

  /**
   * 4 → 5 (phase 6) : aucune vue, style d'impression neutre (« standard » : rendu inchangé),
   * détail complet, aucun élément exclu, pas de styles d'entreprise ; étiquettes et noms de zones
   * à leur place (pas de renvoi) ; aucun problème de lisibilité revu. Géométries inchangées.
   */
  4: (doc) => {
    const plan = isRecord(doc.plan) ? doc.plan : {};
    const print = isRecord(plan.print) ? plan.print : {};
    const objects = isRecord(doc.objects) ? doc.objects : {};
    return {
      ...doc,
      plan: {
        views: [],
        variantOf: null,
        styleOverrides: {},
        ...plan,
        print: { excludedObjectIds: [], detail: 'full', style: { ...DEFAULT_STYLE }, ...print },
      },
      objects: Object.fromEntries(
        Object.entries(objects).map(([id, o]) => [
          id,
          !isRecord(o)
            ? o
            : o.type === 'text'
              ? { leaderTo: null, ...o }
              : o.type === 'zone'
                ? { nameOffset: null, ...o }
                : o,
        ]),
      ),
      readabilityReviews: Array.isArray(doc.readabilityReviews) ? doc.readabilityReviews : [],
    };
  },

  /** 5 → 6 (phase 7) : `plan.draftBase` (null : le plan n'a encore aucune révision figée). */
  5: (doc) => {
    const plan = isRecord(doc.plan) ? doc.plan : {};
    return { ...doc, plan: { draftBase: null, ...plan } };
  },
};

/**
 * 3 → 4 (phase 5) : réglages du plan professionnel (unités, nord non orienté, légende, cartouche,
 * mise en page) ; largeur physique des corridors absente (`widthMeters: null`). Le nord n'est
 * jamais déduit du haut de l'image : il reste « non défini » jusqu'à ce que l'utilisateur l'oriente.
 */
function migrateV3(doc: Record<string, unknown>): Record<string, unknown> {
  const plan = isRecord(doc.plan) ? doc.plan : {};
  const objects = isRecord(doc.objects) ? doc.objects : {};
  return {
    ...doc,
    plan: { ...planDefaults(), ...plan },
    objects: Object.fromEntries(
      Object.entries(objects).map(([id, o]) => [
        id,
        isRecord(o) && o.type === 'corridor' ? { widthMeters: null, ...o } : o,
      ]),
    ),
  };
}

/** Noms figés dans la migration (indépendants des traductions futures). */
const NEW_LAYERS_V3 = [
  ['parking', 'Stationnement'],
  ['deliveries', 'Livraison et débarquement'],
  ['safety', 'Sécurité et accès'],
] as const;

function migrateObjectV3(object: unknown): unknown {
  if (!isRecord(object)) return object;
  switch (object.type) {
    case 'zone':
      return { icon: null, showName: false, ...object };
    case 'flow': {
      const arrows = isRecord(object.arrows) ? object.arrows : {};
      return { category: 'general', ...object, arrows: { visible: true, ...arrows } };
    }
    case 'corridor': {
      const { fillMode: _fillMode, pedestrianIconSpacing, ...rest } = object;
      const width = typeof rest.width === 'number' ? rest.width : 20;
      return {
        showIcons: typeof pedestrianIconSpacing === 'number',
        iconSpacing: typeof pedestrianIconSpacing === 'number' ? pedestrianIconSpacing : width * 5,
        iconSize: width * 0.7,
        iconsOriented: true,
        ...rest,
      };
    }
    case 'icon':
      return { text: null, ...object };
    default:
      return object;
  }
}

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
