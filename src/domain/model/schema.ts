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

export const SCHEMA_VERSION = 1;

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
 * Niveaux de rendu : chaque calque utilisateur appartient à un niveau, et chaque niveau
 * correspond à un `Konva.Layer` distinct (voir `editor/renderTiers.ts`).
 */
export const RENDER_TIERS = ['zones', 'buildings', 'circulation', 'pedestrians', 'signage', 'texts'] as const;
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
  metadata: metadataSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
};

export const arrowSpecSchema = z.object({
  direction: z.enum(['forward', 'backward', 'both']),
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
    arrows: arrowSpecSchema,
  }),
  z.object({
    ...objectBase,
    type: z.literal('corridor'),
    geometry: polylineGeometrySchema,
    /** Largeur du corridor en pixels image. */
    width: z.number().positive(),
    fillMode: z.enum(['solid', 'transparent', 'dashed', 'hatched']),
    /** Espacement des icônes piéton en pixels image ; null = pas d'icônes. */
    pedestrianIconSpacing: z.number().positive().nullable(),
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
    type: z.literal('icon'),
    geometry: pointGeometrySchema,
    symbolId: z.string().min(1),
    /** Taille en pixels image. */
    size: z.number().positive(),
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

export const planSchema = z.object({
  id: idSchema,
  siteId: idSchema,
  name: z.string(),
  kind: z.enum(PLAN_KINDS),
  baseImage: baseImageRefSchema.nullable(),
  calibration: calibrationSchema.nullable(),
  /** Angle du Nord en degrés, sens horaire à partir du haut de l'image. */
  northAngleDeg: z.number(),
  metadata: metadataSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

export const planDocumentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  plan: planSchema,
  /** Ordre du tableau = ordre d'affichage au sein d'un même niveau (index 0 = dessous). */
  layers: z.array(layerSchema).min(1),
  objects: z.record(idSchema, planObjectSchema),
});

export const siteSchema = z.object({
  id: idSchema,
  name: z.string(),
  notes: z.string(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
