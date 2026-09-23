/**
 * Modèle de données versionné d'un projet CampPlanner.
 *
 * Règles structurantes :
 * - Toutes les géométries sont exprimées en **pixels de l'image de base affichée** (espace projet),
 *   jamais en coordonnées écran. Le viewport (zoom/pan) n'apparaît nulle part dans ce modèle.
 * - L'image de base n'est pas un objet éditable : elle est référencée par `plan.baseImage`
 *   et ses octets d'origine sont stockés à part, inchangés.
 * - Chaque schéma zod est la source de vérité : les types TypeScript en sont dérivés.
 */
import { z } from 'zod';

/**
 * Historique du format :
 * - 1 : format initial (phases 0 à 2).
 * - 2 : `groupId` sur chaque objet (regroupement, phase 3).
 * - 3 : circulation et zones opérationnelles (phase 4) : catégories de calques stationnement,
 *   livraison et sécurité ; trajets (catégorie, flèches masquables) ; corridors (pictogrammes) ;
 *   pictogrammes (texte) ; pictogramme et nom affichés dans les zones ; pictogrammes importés
 *   (`assets`) ; suivi des croisements (`crossingReviews`) ; limites d'affichage (`plan.display`).
 * - 4 : plan professionnel (phase 5) : unités, statut du nord, largeur physique des corridors,
 *   cotes (`dimension`), cases de stationnement (`stall`), légende, cartouche, mise en page.
 */
export const SCHEMA_VERSION = 4;

export const idSchema = z.string().min(1);
export const isoDateSchema = z.iso.datetime();
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Couleur attendue au format #RRGGBB');
const unitInterval = z.number().min(0).max(1);
const metadataSchema = z.record(z.string(), z.unknown());

export const pointSchema = z.object({ x: z.number(), y: z.number() });

// ---------------------------------------------------------------------------
// Géométries (espace image)
// ---------------------------------------------------------------------------

export const rectGeometrySchema = z.object({
  kind: z.literal('rect'),
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  cornerRadius: z.number().nonnegative(),
});

export const ellipseGeometrySchema = z.object({
  kind: z.literal('ellipse'),
  cx: z.number(),
  cy: z.number(),
  rx: z.number().nonnegative(),
  ry: z.number().nonnegative(),
});

export const polygonGeometrySchema = z.object({
  kind: z.literal('polygon'),
  points: z.array(pointSchema).min(3),
});

export const polylineGeometrySchema = z.object({
  kind: z.literal('polyline'),
  points: z.array(pointSchema).min(2),
  curved: z.boolean(),
});

export const pointGeometrySchema = z.object({
  kind: z.literal('point'),
  x: z.number(),
  y: z.number(),
});

export const geometrySchema = z.discriminatedUnion('kind', [
  rectGeometrySchema,
  ellipseGeometrySchema,
  polygonGeometrySchema,
  polylineGeometrySchema,
  pointGeometrySchema,
]);

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

export const styleSchema = z.object({
  fill: hexColorSchema.nullable(),
  fillOpacity: unitInterval,
  stroke: hexColorSchema.nullable(),
  strokeOpacity: unitInterval,
  /** Épaisseur de trait en pixels image (suit donc le zoom et l'export). */
  strokeWidth: z.number().nonnegative(),
  dash: z.enum(['solid', 'dashed', 'dotted']),
  pattern: z.enum(['none', 'hatch', 'crosshatch']),
});

// ---------------------------------------------------------------------------
// Calques
// ---------------------------------------------------------------------------

/**
 * Catégories logiques de calques (ordre = ordre des calques par défaut, du dessous au-dessus).
 * Le rendu suit l'ordre réel des calques du plan (voir `editor/renderTiers.ts`).
 */
export const RENDER_TIERS = [
  'zones',
  'parking',
  'deliveries',
  'safety',
  'buildings',
  'circulation',
  'pedestrians',
  'signage',
  'texts',
] as const;
export const renderTierSchema = z.enum(RENDER_TIERS);

export const layerSchema = z.object({
  id: idSchema,
  name: z.string(),
  tier: renderTierSchema,
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: unitInterval,
});

// ---------------------------------------------------------------------------
// Objets
// ---------------------------------------------------------------------------

const objectBase = {
  id: idSchema,
  name: z.string(),
  layerId: idSchema,
  /** Identifiant du preset d'origine (ex. `zone.stationnement`), null si objet libre. */
  presetId: z.string().nullable(),
  style: styleSchema,
  /**
   * Rotation en degrés (sens horaire) autour du CENTRE de la géométrie : centre du rectangle ou de
   * l'ellipse, centre de la boîte englobante des points, point d'ancrage (centre) d'un texte.
   * L'échelle, elle, n'est jamais stockée : elle est intégrée à la géométrie (largeur, points, taille).
   */
  rotation: z.number(),
  visible: z.boolean(),
  locked: z.boolean(),
  /** Ordre d'empilement au sein du calque (plus grand = au-dessus). */
  zIndex: z.number().int(),
  /** Groupe d'objets manipulés ensemble (null = objet non groupé). */
  groupId: idSchema.nullable(),
  metadata: metadataSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
};

/** Pictogramme d'une zone (au centre de la zone). `size` en pixels image. */
export const zoneIconSchema = z.object({ symbolId: z.string().min(1), size: z.number().positive() });

export const FLOW_CATEGORIES = [
  'light',
  'heavy',
  'delivery',
  'service',
  'emergency',
  'general',
  'custom',
] as const;

export const arrowSpecSchema = z.object({
  /** `forward` = sens du tracé (premier → dernier point) ; `both` = double sens. */
  direction: z.enum(['forward', 'backward', 'both']),
  visible: z.boolean(),
  /** Taille d'une flèche, en pixels image. */
  size: z.number().positive(),
  /** Distance entre deux flèches le long du tracé, en pixels image. */
  spacing: z.number().positive(),
});

export const labelSpecSchema = z.object({
  background: hexColorSchema,
  backgroundOpacity: unitInterval,
  border: hexColorSchema.nullable(),
  /** Épaisseur de la bordure, en pixels image. */
  borderWidth: z.number().nonnegative(),
  /** Marge intérieure, en pixels image. */
  padding: z.number().nonnegative(),
  /** Rayon des coins du fond, en pixels image. */
  cornerRadius: z.number().nonnegative(),
});

export const planObjectSchema = z.discriminatedUnion('type', [
  z.object({
    ...objectBase,
    type: z.literal('zone'),
    geometry: z.discriminatedUnion('kind', [
      rectGeometrySchema,
      ellipseGeometrySchema,
      polygonGeometrySchema,
    ]),
    icon: zoneIconSchema.nullable(),
    /** Affiche le nom de la zone en son centre. */
    showName: z.boolean(),
  }),
  z.object({
    ...objectBase,
    type: z.literal('building'),
    geometry: z.discriminatedUnion('kind', [
      rectGeometrySchema,
      ellipseGeometrySchema,
      polygonGeometrySchema,
    ]),
  }),
  z.object({ ...objectBase, type: z.literal('line'), geometry: polylineGeometrySchema }),
  z.object({
    ...objectBase,
    type: z.literal('flow'),
    geometry: polylineGeometrySchema,
    category: z.enum(FLOW_CATEGORIES),
    arrows: arrowSpecSchema,
  }),
  z.object({
    ...objectBase,
    type: z.literal('corridor'),
    geometry: polylineGeometrySchema,
    /**
     * Largeur du corridor en pixels IMAGE. Remplissage = `style.fill`, bordure = `style.stroke`.
     * Si `widthMeters` est défini ET que le plan est calibré, c'est la largeur physique qui
     * s'applique (convertie à l'affichage) ; `width` reste la dernière largeur en pixels connue.
     */
    width: z.number().positive(),
    /** Largeur physique en mètres (null = largeur définie en pixels). */
    widthMeters: z.number().positive().nullable(),
    showIcons: z.boolean(),
    /** Espacement des pictogrammes piétons le long du tracé, en pixels image. */
    iconSpacing: z.number().positive(),
    /** Taille des pictogrammes, en pixels image. */
    iconSize: z.number().positive(),
    /** Pictogrammes orientés dans le sens du déplacement (sinon droits). */
    iconsOriented: z.boolean(),
  }),
  z.object({
    ...objectBase,
    type: z.literal('text'),
    /** Centre du bloc de texte (ou de l'étiquette). La couleur du texte est `style.fill`. */
    geometry: pointGeometrySchema,
    text: z.string(),
    fontFamily: z.string(),
    /** Taille en pixels image. */
    fontSize: z.number().positive(),
    fontWeight: z.enum(['normal', 'bold']),
    italic: z.boolean(),
    align: z.enum(['left', 'center', 'right']),
    /** Non nul = étiquette (texte sur fond avec marge et bordure). */
    label: labelSpecSchema.nullable(),
  }),
  z.object({
    ...objectBase,
    /** Cote : distance mesurée le long de la polyligne, affichée en mètres si le plan est calibré. */
    type: z.literal('dimension'),
    geometry: polylineGeometrySchema,
  }),
  z.object({
    ...objectBase,
    /** Case de stationnement (générée ou dessinée) ; modifiable individuellement. */
    type: z.literal('stall'),
    geometry: rectGeometrySchema,
    /** Zone de stationnement d'origine (null si la case a été détachée ou dessinée seule). */
    parentZoneId: idSchema.nullable(),
  }),
  z.object({
    ...objectBase,
    type: z.literal('icon'),
    geometry: pointGeometrySchema,
    /** Pictogramme de la bibliothèque (`sign.*`) ou importé (`asset:<id>`). */
    symbolId: z.string().min(1),
    /** Taille en pixels image. */
    size: z.number().positive(),
    /** Texte affiché par certains pictogrammes (ex. limite de vitesse « 20 »). */
    text: z.string().nullable(),
  }),
]);

// ---------------------------------------------------------------------------
// Image de base, calibration, plan, site
// ---------------------------------------------------------------------------

export const baseImageRefSchema = z.object({
  /** Référence vers les octets d'origine stockés séparément (jamais réencodés). */
  blobId: idSchema,
  fileName: z.string(),
  mimeType: z.string(),
  byteLength: z.number().int().nonnegative(),
  /** Empreinte SHA-256 (hex) des octets d'origine, vérifiée à la réouverture. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Dimensions de l'image telle qu'affichée (orientation EXIF appliquée) = espace projet. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Orientation EXIF lue dans le fichier (1 = aucune). Appliquée à l'affichage seulement. */
  exifOrientation: z.number().int().min(1).max(8),
  importedAt: isoDateSchema,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('image') }),
    z.object({
      kind: z.literal('pdf'),
      /**
       * PDF d'origine, conservé tel quel. L'image de fond (`blobId`) est la page RASTÉRISÉE, encodée en PNG, rendue
       * depuis ce PDF à `dpi` : elle peut être régénérée à tout moment depuis l'original.
       */
      pdfBlobId: idSchema,
      pdfFileName: z.string(),
      pdfByteLength: z.number().int().nonnegative(),
      pdfSha256: z.string().regex(/^[0-9a-f]{64}$/),
      pageCount: z.number().int().positive(),
      page: z.number().int().positive(),
      dpi: z.number().positive(),
    }),
  ]),
});

export const calibrationSchema = z.object({
  p1: pointSchema,
  p2: pointSchema,
  distanceMeters: z.number().positive(),
});

export const PLAN_KINDS = [
  'general',
  'winter-circulation',
  'summer-circulation',
  'safety',
  'evacuation',
  'snow-removal',
  'deliveries',
  'future-works',
  'other',
] as const;

/**
 * Limites d'affichage des éléments répétés (flèches, pictogrammes des corridors et des zones), en
 * pixels ÉCRAN : lisibles à tout zoom, sans devenir gigantesques. N'affecte pas la géométrie.
 */
export const displaySettingsSchema = z
  .object({
    symbolMinPx: z.number().min(4).max(400),
    symbolMaxPx: z.number().min(4).max(400),
  })
  .refine((d) => d.symbolMinPx <= d.symbolMaxPx, 'La taille minimale dépasse la taille maximale.');

export const NORTH_STATUSES = ['undefined', 'estimated', 'verified'] as const;
export const PLAN_STATUSES = ['draft', 'review', 'field-validation', 'approved'] as const;
export const PAPER_SIZES = ['letter', 'legal', 'tabloid', 'a4', 'a3', 'a2', 'a1'] as const;
export const LEGEND_PLACEMENTS = [
  'side',
  'map-auto',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

/** Légende automatique : les entrées sont calculées ; seuls les choix de l'utilisateur sont stockés. */
export const legendSettingsSchema = z.object({
  visible: z.boolean(),
  title: z.string(),
  placement: z.enum(LEGEND_PLACEMENTS),
  mode: z.enum(['compact', 'detailed']),
  /** Facteur de taille (1 = normal). */
  sizeFactor: z.number().min(0.5).max(2.5),
  /** Clés d'entrées exclues. */
  hidden: z.array(z.string()),
  /** Intitulés personnalisés par clé d'entrée. */
  labels: z.record(z.string(), z.string()),
});

export const titleBlockSchema = z.object({
  campName: z.string(),
  title: z.string(),
  client: z.string(),
  company: z.string(),
  preparedBy: z.string(),
  checkedBy: z.string(),
  approvedBy: z.string(),
  /** Date du plan (AAAA-MM-JJ) ; vide = date de l'export. */
  date: z.string(),
  planNumber: z.string(),
  revision: z.string(),
  notes: z.string(),
  /** « Approuvé » n'est JAMAIS attribué automatiquement (choix explicite, confirmé). */
  status: z.enum(PLAN_STATUSES),
  /** Moment de l'approbation explicite (null si le plan n'est pas approuvé). */
  approvedAt: isoDateSchema.nullable(),
  /** Logo : pictogramme importé du plan (`assets`). */
  logoAssetId: idSchema.nullable(),
  placement: z.enum(['side', 'bottom']),
});

export const printSettingsSchema = z.object({
  paper: z.enum(PAPER_SIZES),
  orientation: z.enum(['portrait', 'landscape']),
  marginMm: z.number().min(0).max(50),
  /** complet : photo + annotations + légende + cartouche ; simplifié : sans cartouche ; annotations seules. */
  mode: z.enum(['complete', 'simplified', 'annotations']),
  /** Résolution de rendu (points par pouce) des images et des exports PNG / JPG. */
  dpi: z.number().int().min(72).max(600),
  jpegQuality: z.number().min(0.4).max(1),
  /** Étendue : photo entière, ou zone annotée (avec une marge). */
  extent: z.enum(['image', 'annotations']),
  /** Fond des annotations seules : blanc ou transparent (PNG uniquement). */
  background: z.enum(['white', 'transparent']),
  include: z.object({
    title: z.boolean(),
    legend: z.boolean(),
    titleBlock: z.boolean(),
    logo: z.boolean(),
    north: z.boolean(),
    scaleBar: z.boolean(),
    date: z.boolean(),
    revision: z.boolean(),
    notes: z.boolean(),
  }),
  /** Calques non exportés. */
  excludedLayerIds: z.array(idSchema),
});

export const planSchema = z.object({
  id: idSchema,
  siteId: idSchema,
  name: z.string(),
  kind: z.enum(PLAN_KINDS),
  baseImage: baseImageRefSchema.nullable(),
  calibration: calibrationSchema.nullable(),
  /** Angle du Nord en degrés, sens horaire à partir du haut de l'image. */
  northAngleDeg: z.number(),
  /** Le haut de l'image n'est jamais supposé être le nord : `undefined` tant qu'il n'est pas orienté. */
  northStatus: z.enum(NORTH_STATUSES),
  units: z.enum(['metric', 'imperial']),
  display: displaySettingsSchema,
  legend: legendSettingsSchema,
  titleBlock: titleBlockSchema,
  print: printSettingsSchema,
  metadata: metadataSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

export const symbolAssetSchema = z.object({
  id: idSchema,
  name: z.string(),
  blobId: idSchema,
  mimeType: z.enum(['image/png', 'image/svg+xml']),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: isoDateSchema,
});

/**
 * Décision de l'utilisateur sur un croisement détecté entre un trajet et un corridor. Retrouvée
 * par la paire d'objets et la position (tolérance), car la géométrie peut évoluer.
 */
export const crossingReviewSchema = z.object({
  id: idSchema,
  flowId: idSchema,
  corridorId: idSchema,
  point: pointSchema,
  /** `vigilance` = point de vigilance ; `verified` = vérifié, marqueur masqué. */
  status: z.enum(['open', 'vigilance', 'verified']),
  note: z.string(),
  updatedAt: isoDateSchema,
});

export const planDocumentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  plan: planSchema,
  /** Ordre du tableau = ordre d'affichage au sein d'un même niveau (index 0 = dessous). */
  layers: z.array(layerSchema).min(1),
  objects: z.record(idSchema, planObjectSchema),
  /** Pictogrammes importés (PNG ou SVG vérifié) ; octets d'origine stockés à part. */
  assets: z.record(idSchema, symbolAssetSchema),
  /** Suivi des croisements piétons / véhicules détectés (aide à la planification seulement). */
  crossingReviews: z.array(crossingReviewSchema),
});

export const siteSchema = z.object({
  id: idSchema,
  name: z.string(),
  notes: z.string(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
